import type {
  Case,
  CaseSummary,
  CaseWarning,
  CommandCenter,
  Hypothesis,
  MetricEstimate,
  MissingEvidence,
  SkillMatch,
} from '@caseguard/schemas';
import type { CaseListItem } from '../../db';
import type { RequestContext } from '../../http/request-context';
import { listCases, summarizeCase } from '../cases';
import { buildSystemHealth, readAiHealth, type SystemHealthDeps } from '../system';
import { defaultCaseId, previousAnalysedCase } from './active-case';
import { buildCards, type TrendBase } from './cards';
import { summarizeHealth } from './health-summary';
import { commandCenterNotices } from './notices';
import {
  LIST_LIMITS,
  bestSkillMatch,
  criticalMissingOf,
  leadingHypothesisOf,
  openWarningsOf,
  skillCandidatesOf,
} from './picks';

/** Cases considered for the default case and for the trend base (newest analysed first). */
const ANALYSED_CASES = 200;
const SKILLS_CONSIDERED = 100;

/** Everything the active case contributes; all empty when there is no case to show. */
interface ActiveCaseData {
  readonly summary: CaseSummary | null;
  readonly estimates: MetricEstimate[];
  readonly hypotheses: Hypothesis[];
  readonly warnings: CaseWarning[];
  readonly missing: MissingEvidence[];
  readonly matches: SkillMatch[];
  /** The previous analysed case's estimates (the base of the trends). */
  readonly earlier: MetricEstimate[];
}

const NO_CASE: ActiveCaseData = {
  summary: null,
  estimates: [],
  hypotheses: [],
  warnings: [],
  missing: [],
  matches: [],
  earlier: [],
};

async function loadActive(
  ctx: RequestContext,
  record: Case,
  previous: Pick<CaseListItem, 'id'> | null,
): Promise<ActiveCaseData> {
  const { analysis, skills } = ctx.repos;
  const [summary, estimates, hypotheses, warnings, missing, matches, earlier] = await Promise.all([
    summarizeCase(ctx, record),
    analysis.listMetrics(record.id),
    analysis.listHypotheses(record.id),
    analysis.listWarnings(record.id, { state: 'open' }),
    analysis.listMissing(record.id),
    skills.listMatchesForCase(record.id),
    previous === null ? Promise.resolve([]) : analysis.listMetrics(previous.id),
  ]);
  return { summary, estimates, hypotheses, warnings, missing, matches, earlier };
}

/**
 * `dashboard.commandCenter`: the quality picture of one case plus the tenant-wide lists around it.
 *
 * The case is the one asked for, else the most recently analysed one (a requested case that is not
 * found, or belongs to another tenant, falls back to the default and says so). Its cards, warnings,
 * missing evidence, leading hypothesis and skill match come from its stored analysis; recent cases,
 * skill candidates and the system summary do not depend on it. Nothing is computed that the analysis
 * did not store, a trend only exists against an earlier analysed case, and a tenant without cases gets
 * valid, honest, empty answers.
 */
export async function getCommandCenter(
  ctx: RequestContext,
  health: SystemHealthDeps,
  query: { readonly caseId?: string | undefined },
): Promise<CommandCenter> {
  const requested = query.caseId === undefined ? null : await ctx.repos.cases.get(query.caseId);
  const [analysed, recent, library, ai] = await Promise.all([
    ctx.repos.cases.list({ limit: ANALYSED_CASES, analysisState: 'analyzed' }),
    listCases(ctx, { limit: LIST_LIMITS.recentCases }),
    ctx.repos.skills.list({ limit: SKILLS_CONSIDERED }),
    readAiHealth(ctx),
  ]);
  const activeId = requested?.id ?? defaultCaseId(analysed.items, recent.items[0]?.id ?? null);
  const record = requested ?? (activeId === null ? null : await ctx.repos.cases.get(activeId));
  const previous = record === null ? null : previousAnalysedCase(analysed.items, record);
  const active = record === null ? NO_CASE : await loadActive(ctx, record, previous);

  const base: TrendBase | null =
    previous === null || active.estimates.length === 0 || active.earlier.length === 0
      ? null
      : { reference: previous.reference, estimates: active.earlier };
  const systemHealth = summarizeHealth(await buildSystemHealth(health, ai));

  return {
    generatedAt: ctx.now().toISOString(),
    activeCase: active.summary,
    metrics: buildCards({
      caseId: record?.id ?? null,
      synthetic: record?.synthetic ?? false,
      estimates: active.estimates,
      base,
    }),
    criticalMissingEvidence:
      record === null ? [] : criticalMissingOf(active.missing, record.id, LIST_LIMITS.missing),
    leadingHypothesis: leadingHypothesisOf(active.hypotheses),
    skillMatch: bestSkillMatch(active.matches),
    openWarnings: openWarningsOf(active.warnings, LIST_LIMITS.warnings),
    recentCases: recent.items,
    skillCandidates: skillCandidatesOf(library.items, LIST_LIMITS.candidates),
    systemHealth,
    notices: commandCenterNotices({
      hasCases: record !== null,
      hasActiveCase: record !== null,
      activeAnalysed: active.estimates.length > 0,
      requestedMissing: query.caseId !== undefined && requested === null,
      trendBase: base?.reference ?? null,
      analysedCases: analysed.items.length,
      providerSimulated: systemHealth.providerSimulated,
    }),
  };
}
