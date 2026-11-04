import {
  getCompiledPack,
  listKnowledgePacks,
  type CompiledPack,
  type EngineContext,
  type MatchableSkill,
} from '@caseguard/domain';
import type {
  ActionValueConfig,
  AnalysisRun,
  Case,
  CaseEvent,
  CaseResolution,
  CaseSource,
  QualityConfig,
} from '@caseguard/schemas';
import { canonicalJson, sha256Hex } from '@caseguard/security';
import { NotFoundError, ValidationFailedError } from '../../errors';
import type { RequestContext } from '../../http/request-context';

/**
 * Bump when the meaning of any analysis output changes (engine, scoring, warning rules). It is part
 * of the input hash, so a new engine re-analyses cases instead of silently reusing stale results.
 *
 * 2026.2.0: a view's belief is one number (the analysis belief equals the last timeline step, so
 * decision-time rankings, fork posteriors and simulated start beliefs moved by a few thousandths) and
 * scenario summaries no longer compare with the real case.
 * 2026.2.1: the token-efficiency figure of a synthetic case reads "simulated telemetry" instead of
 * "measured" (text only; no number moved).
 * 2026.3.0: no generated id enters a seed or an ordering (see `simulationSeed`), so the same case
 * content gives the same simulated numbers in every database. Every simulated figure moved once
 * (rollouts, confidence bands, skill baselines); stored runs are recomputed and the decisions on their
 * scenarios are reset (and audited) because the regenerated simulation differs.
 * 2026.3.1: a source reference names the text its offsets count into (`SourceRef.field`: the title, the
 * body, or both). Offsets of a match in the body now count from the start of the body instead of from the
 * start of the title, and the pointer says which text that is. Every score, id, ranking and text is
 * unchanged, so no simulated figure is redrawn; stored runs are recomputed once to carry the field.
 * 2026.4.0: detection reads whether a sentence states a fact (a denial, a guess, a plan, a condition or a
 * report from someone else does not), reads chat shorthand and typos through a fixed list, ignores what an
 * e-mail only quotes, and knows more of the ways the same fact is worded (docs/DETECTION.md). A denial of
 * one side of a declared signal pair reads as the other side. The analysis also carries conflicts and
 * sequence findings, and the observations it dropped for not stating a fact. On the two shipped samples:
 * Case One reads the same signals (one excerpt is a few words longer); Case Two reads two more (the customer's
 * "we have not changed Conditional Access" and the engineer's note that one proxy node timed out), and its
 * headline figures, forks and band are unchanged. Figures and times the customer gives ("140 users", "since
 * 08:50") are read by the same rule, so "no sign-in tickets since 11:45" is no longer a second start of the
 * failures: against 2026.3.1 Case One's ledger loses the two claims that mistake caused (the attribute claim and
 * the "conflicting evidence" claim it set off), and Case Two's loses the same two and gains two for its extra
 * signals; no score, band, fork or simulated figure moves. Stored runs are recomputed once. Each counterfactual
 * path also says how far to trust it (what its figures rest on, whether it could have been followed, what limits
 * it, what to check, which skill would have applied); no figure of a path moved.
 */
export const ENGINE_VERSION = '2026.4.0';

/** Everything an analysis reads. Loaded once per run and never mutated. */
export interface AnalysisInputs {
  readonly caseRecord: Case;
  readonly source: CaseSource;
  readonly events: readonly CaseEvent[];
  readonly resolution: CaseResolution | null;
  readonly pack: CompiledPack;
  readonly actionConfig: ActionValueConfig;
  readonly qualityConfig: QualityConfig;
  /** Skills that may match this case (pilot, validated or published for the workload). */
  readonly skills: readonly MatchableSkill[];
  readonly unitPrices: {
    readonly inputPer1kUsd: number | null;
    readonly outputPer1kUsd: number | null;
    readonly cachedInputPer1kUsd: number | null;
  };
}

/** Loads a case with everything its analysis depends on. 404 across tenants, 422 for an unknown workload. */
export async function loadAnalysisInputs(
  ctx: RequestContext,
  caseId: string,
): Promise<AnalysisInputs> {
  const caseRecord = await ctx.repos.cases.get(caseId);
  if (caseRecord === null) throw new NotFoundError('Case', caseId);

  const pack = getCompiledPack(caseRecord.workload);
  if (pack === null) {
    const supported = listKnowledgePacks()
      .map((knowledge) => knowledge.workload)
      .join(', ');
    throw new ValidationFailedError(
      `No knowledge pack is available for the "${caseRecord.workload}" workload (supported: ${supported})`,
      [{ path: 'case.workload', message: 'Unsupported workload' }],
    );
  }

  const [source, events, resolution, settings, skills] = await Promise.all([
    ctx.repos.cases.getSource(caseId),
    ctx.repos.cases.getAllEvents(caseId),
    ctx.repos.cases.getResolution(caseId),
    ctx.repos.governance.getSettings(),
    ctx.repos.skills.listMatchable(caseRecord.workload),
  ]);
  if (source === null) throw new NotFoundError('Case source', caseId);

  return {
    caseRecord,
    source,
    events,
    resolution,
    pack,
    actionConfig: settings.action_value.value,
    qualityConfig: settings.quality.value,
    skills,
    unitPrices: {
      inputPer1kUsd: settings.model.value.unitPrices.inputPer1kUsd,
      outputPer1kUsd: settings.model.value.unitPrices.outputPer1kUsd,
      cachedInputPer1kUsd: settings.model.value.unitPrices.cachedInputPer1kUsd,
    },
  };
}

export interface ProviderIdentity {
  readonly kind: string;
  readonly model: string;
}

export interface EngineContextInput {
  readonly tenantId: string;
  readonly caseId: string;
  readonly runId: string;
  readonly startedAt: string;
  /** From `simulationSeed`: never from a hash that covers generated ids. */
  readonly seed: string;
}

/**
 * The seed of every simulation of a case: the confidence bands, the counterfactual rollouts and the
 * skill baselines all draw from streams named by it. It covers the CONTENT being simulated (the stored
 * payload's content hash, how many events and whether it is resolved, and the pack) and nothing that
 * is generated per database: not the tenant, case, run or source ids, not the skill library (its ids
 * are random) and not the provider. The engine version is left out too, so a release that moves no
 * number redraws none. Same content therefore gives the same simulated numbers in any database, and
 * a library or provider change does not redraw a case that is analysed again.
 *
 * `computeInputHash` remains the IDENTITY of an input (it must change when a skill is added, because
 * matching has to re-run); this is only the seed. It is recomputed from the stored record, so replaying
 * a stored run (`engineContextForRun`) draws exactly the streams that run drew.
 */
export function simulationSeed(
  inputs: Pick<AnalysisInputs, 'source' | 'events' | 'resolution' | 'pack'>,
): string {
  return sha256Hex(
    canonicalJson({
      source: inputs.source.receivedSha256,
      events: inputs.events.length,
      resolution: inputs.resolution !== null,
      pack: [inputs.pack.pack.id, inputs.pack.pack.version],
    }),
  );
}

/**
 * The identity the engine runs under. Artefact ids and timestamps derive from the run and the case; the
 * simulation seed does not (see `simulationSeed`). A view that recomputes an analysis from the stored
 * record (for an as-of request) must build its context with `engineContextForRun` to get exactly the ids
 * that were stored.
 */
export function engineContextFor(input: EngineContextInput): EngineContext {
  return {
    tenantId: input.tenantId,
    caseId: input.caseId,
    runId: input.runId,
    now: input.startedAt,
    createdBy: 'system:analysis',
    seed: input.seed,
  };
}

export function engineContextForRun(run: AnalysisRun, inputs: AnalysisInputs): EngineContext {
  return engineContextFor({
    tenantId: run.tenantId,
    caseId: run.caseId,
    runId: run.id,
    startedAt: run.startedAt,
    seed: simulationSeed(inputs),
  });
}

/**
 * Identifies the exact input of an analysis. Identical input never re-runs. The hash covers what can
 * change the result (the stored payload, the pack, both governed configurations, the skill library the
 * matcher sees, the engine version and the provider) and nothing that cannot, such as reviewer
 * corrections (they are carried forward across runs).
 */
export function computeInputHash(inputs: AnalysisInputs, provider: ProviderIdentity): string {
  return sha256Hex(
    canonicalJson({
      engine: ENGINE_VERSION,
      source: inputs.source.receivedSha256,
      events: inputs.events.length,
      resolution: inputs.resolution !== null,
      pack: [inputs.pack.pack.id, inputs.pack.pack.version],
      actionConfig: sha256Hex(canonicalJson(inputs.actionConfig)),
      qualityConfig: sha256Hex(canonicalJson(inputs.qualityConfig)),
      skills: inputs.skills
        .map((entry) => [entry.skill.id, entry.version.id, entry.skill.lifecycle])
        .sort(),
      provider: [provider.kind, provider.model],
    }),
  );
}
