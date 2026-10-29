import {
  CaseSummarySchema,
  CaseWarningSchema,
  IdSchema,
  MissingEvidenceSchema,
  PrioritySchema,
  type CaseWarning,
  type MissingEvidence,
} from '@caseguard/schemas';
import { z } from 'zod';
import { ValidationFailedError } from '../../errors';
import { parseStored, validateInput, type DataRow, type RepoContext } from './support';
import type { AnalysisRepository, CaseAnalysisSummary } from './types';

/** Case ids one `summarize` call accepts. */
export const MAX_SUMMARY_CASES = 200;
/** Largest tenant-wide list the dashboard read models return. */
export const MAX_DASHBOARD_LIST = 100;

const MAX_ID_CHARS = 120;

const CriticalitySchema = MissingEvidenceSchema.shape.criticality;
type CriticalMissingQuery = Parameters<AnalysisRepository['listCriticalMissing']>[0];

/** Ranking position is the index in these lists, so both enums must stay declared most severe first. */
export const WARNING_PRIORITY_ORDER: readonly string[] = PrioritySchema.options;
export const MISSING_CRITICALITY_ORDER: readonly string[] = CriticalitySchema.options;

const SummarySchema = z.object({ caseId: IdSchema }).extend(
  CaseSummarySchema.pick({
    qualityIndex: true,
    avoidableEffortPct: true,
    leadingHypothesis: true,
    openWarningCount: true,
  }).shape,
);

const ListQuerySchema = z.object({ limit: z.number().int().min(1).max(MAX_DASHBOARD_LIST) });
const CriticalMissingQuerySchema = ListQuerySchema.extend({
  minCriticality: CriticalitySchema.optional(),
});
const MissingWithCaseSchema = MissingEvidenceSchema.extend({ caseId: IdSchema });

/**
 * One statement for the whole id list: every analysis-derived field comes from a lateral lookup on the
 * case's own rows (primary-key prefixes), restricted to the case's latest run. Cases without an
 * analysis have no run, so every lookup finds nothing and the case reports null/null/null/0. Warnings
 * are counted by state, as `listWarnings` does. $1 = tenant, $2 = case ids.
 * (The three statements are exported for the tests that prove which indexes serve them.)
 */
export const SUMMARY_SQL = `
SELECT c.id AS case_id,
       quality.score AS quality_index,
       ase.value AS avoidable_effort_pct,
       top_hypothesis.name AS leading_name,
       top_hypothesis.confidence AS leading_confidence,
       coalesce(open_warnings.n, 0) AS open_warning_count
  FROM cases c
  LEFT JOIN LATERAL (
    SELECT q.composite_score AS score
      FROM quality_assessments q
     WHERE q.tenant_id = c.tenant_id AND q.case_id = c.id
       AND q.analysis_run_id = c.last_analysis_run_id
     ORDER BY q.created_at DESC, q.id DESC
     LIMIT 1
  ) quality ON true
  LEFT JOIN LATERAL (
    SELECT CASE WHEN m.status <> 'unknown' THEN m.value END AS value
      FROM metric_estimates m
     WHERE m.tenant_id = c.tenant_id AND m.case_id = c.id
       AND m.key = 'avoidable_support_effort'
       AND m.analysis_run_id = c.last_analysis_run_id
     LIMIT 1
  ) ase ON true
  LEFT JOIN LATERAL (
    SELECT h.name, h.current_confidence AS confidence
      FROM hypotheses h
     WHERE h.tenant_id = c.tenant_id AND h.case_id = c.id
       AND h.analysis_run_id = c.last_analysis_run_id
     ORDER BY h.current_confidence DESC, h.ordinal, h.id
     LIMIT 1
  ) top_hypothesis ON true
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS n
      FROM case_warnings w
     WHERE w.tenant_id = c.tenant_id AND w.case_id = c.id AND w.state = 'open'
  ) open_warnings ON true
 WHERE c.tenant_id = $1 AND c.id = ANY($2::text[])`;

/**
 * $1 = tenant, $2 = priorities most severe first (they also give the ranking), $3 = limit. The
 * `state = 'open'` literal is what lets the partial index (0008) serve it.
 */
export const OPEN_WARNINGS_SQL = `
SELECT data FROM case_warnings
 WHERE tenant_id = $1 AND state = 'open'
 ORDER BY array_position($2::text[], priority), raised_at DESC, rank, case_id, id
 LIMIT $3::integer`;

/**
 * Only rows of the case's latest run (`last_analysis_run_id`). $1 = tenant, $2 = the criticalities
 * wanted, most severe first (they also give the ranking), $3 = limit. The `resolved_at IS NULL`
 * condition is what lets the partial index (0008) serve it.
 */
export const CRITICAL_MISSING_SQL = `
SELECT m.data, m.case_id
  FROM missing_evidence m
  JOIN cases c ON c.tenant_id = m.tenant_id AND c.id = m.case_id
              AND c.last_analysis_run_id = m.analysis_run_id
 WHERE m.tenant_id = $1 AND m.resolved_at IS NULL AND m.criticality = ANY($2::text[])
 ORDER BY array_position($2::text[], m.criticality), m.first_relevant_at DESC, m.case_id, m.id
 LIMIT $3::integer`;

interface SummaryRow {
  case_id: string;
  quality_index: number | null;
  avoidable_effort_pct: number | null;
  leading_name: string | null;
  leading_confidence: number | null;
  open_warning_count: number;
}

function validateCaseIds(input: unknown): string[] {
  if (!Array.isArray(input)) {
    throw new ValidationFailedError('Invalid case ids', [
      { path: 'caseIds', message: 'Expected a list of case ids' },
    ]);
  }
  const requested: unknown[] = input;
  if (requested.length > MAX_SUMMARY_CASES) {
    throw new ValidationFailedError(
      `Too many case ids: at most ${MAX_SUMMARY_CASES} can be summarised at once`,
      [
        {
          path: 'caseIds',
          message: `Received ${requested.length} ids; the limit is ${MAX_SUMMARY_CASES}`,
        },
      ],
    );
  }
  const valid: string[] = [];
  requested.forEach((id, index) => {
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      id.length > MAX_ID_CHARS ||
      /\p{Cc}/u.test(id)
    ) {
      throw new ValidationFailedError('Invalid case id', [
        {
          path: `caseIds.${index}`,
          message: `Expected a non-empty string of at most ${MAX_ID_CHARS} characters without control characters`,
        },
      ]);
    }
    valid.push(id);
  });
  return [...new Set(valid)];
}

/**
 * Dashboard-oriented read models over the analysis artefacts: they are kept apart from the
 * per-case repository methods because they look across cases (and so share one statement per call).
 */
export class AnalysisReadModels {
  constructor(protected readonly ctx: RepoContext) {}

  async summarize(caseIds: readonly string[]): Promise<CaseAnalysisSummary[]> {
    const ids = validateCaseIds(caseIds);
    if (ids.length === 0) return [];
    return this.ctx.run(async (tx) => {
      const result = await tx.query<SummaryRow>(SUMMARY_SQL, [this.ctx.scope.tenantId, ids]);
      const found = new Map<string, CaseAnalysisSummary>();
      for (const row of result.rows) {
        found.set(
          row.case_id,
          parseStored(
            SummarySchema,
            {
              caseId: row.case_id,
              qualityIndex: row.quality_index,
              avoidableEffortPct: row.avoidable_effort_pct,
              leadingHypothesis:
                row.leading_name === null
                  ? null
                  : { name: row.leading_name, confidence: row.leading_confidence },
              openWarningCount: row.open_warning_count,
            },
            'case analysis summary',
          ),
        );
      }
      // Requested order, unknown ids omitted.
      return ids.flatMap((id) => {
        const summary = found.get(id);
        return summary ? [summary] : [];
      });
    });
  }

  async listOpenWarnings(query: { limit: number }): Promise<CaseWarning[]> {
    const { limit } = validateInput(ListQuerySchema, query, 'open warnings query');
    return this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow>(OPEN_WARNINGS_SQL, [
        this.ctx.scope.tenantId,
        [...WARNING_PRIORITY_ORDER],
        limit,
      ]);
      return result.rows.map((row) => parseStored(CaseWarningSchema, row.data, 'case warning'));
    });
  }

  async listCriticalMissing(
    query: CriticalMissingQuery,
  ): Promise<(MissingEvidence & { caseId: string })[]> {
    const { limit, minCriticality } = validateInput(
      CriticalMissingQuerySchema,
      query,
      'critical missing evidence query',
    );
    const wanted = minCriticality
      ? MISSING_CRITICALITY_ORDER.slice(0, MISSING_CRITICALITY_ORDER.indexOf(minCriticality) + 1)
      : [...MISSING_CRITICALITY_ORDER];
    return this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow & { case_id: string }>(CRITICAL_MISSING_SQL, [
        this.ctx.scope.tenantId,
        wanted,
        limit,
      ]);
      return result.rows.map((row) =>
        parseStored(
          MissingWithCaseSchema,
          { ...(row.data as Record<string, unknown>), caseId: row.case_id },
          'missing evidence',
        ),
      );
    });
  }
}
