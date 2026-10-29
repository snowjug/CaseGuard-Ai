import {
  AnalysisRunSchema,
  CaseSchema,
  CaseWarningSchema,
  ClaimSchema,
  CoachingReportSchema,
  DecisionForkSchema,
  DiagnosticActionSchema,
  DigitalTwinSchema,
  EvidenceSchema,
  HypothesisEvidenceLinkSchema,
  HypothesisSchema,
  MetricEstimateSchema,
  MissingEvidenceSchema,
  ModelExecutionWithUsageSchema,
  QualityAssessmentSchema,
  SkillMatchSchema,
  type CaseWarning,
  type Claim,
  type DecisionFork,
  type SkillMatch,
} from '@caseguard/schemas';
import { z } from 'zod';
import { ValidationFailedError } from '../../errors';
import {
  ANALYSIS_RUNS,
  CASES,
  CASE_WARNINGS,
  CLAIMS,
  COACHING_REPORTS,
  DECISION_FORKS,
  DIAGNOSTIC_ACTIONS,
  DIGITAL_TWINS,
  EVIDENCE,
  HYPOTHESES,
  LINKS,
  METRIC_ESTIMATES,
  MISSING_EVIDENCE,
  QUALITY_ASSESSMENTS,
  QUALITY_DIMENSIONS,
  SKILL_MATCHES,
} from './table-specs';
import {
  assertTenant,
  insertRows,
  loadVersioned,
  nowIso,
  parseStored,
  unique,
  updateRow,
  validateInput,
  type DataRow,
  type RepoContext,
} from './support';
import { upsertExecutions } from './telemetry-repository';
import type { AnalysisSnapshot, SqlExecutor } from './types';

/** Upper bounds that keep every unpaged artefact list bounded by construction. */
export const SNAPSHOT_LIMITS = {
  evidence: 10_000,
  links: 50_000,
  claims: 10_000,
  missing: 500,
  hypotheses: 50,
  actions: 2_000,
  forks: 500,
  metrics: 50,
  warnings: 1_000,
  skillMatches: 200,
  executions: 500,
} as const;

const SnapshotSchema = z.object({
  run: AnalysisRunSchema,
  twin: DigitalTwinSchema,
  evidence: z.array(EvidenceSchema),
  links: z.array(HypothesisEvidenceLinkSchema),
  claims: z.array(ClaimSchema),
  missing: z.array(MissingEvidenceSchema),
  hypotheses: z.array(HypothesisSchema),
  actions: z.array(DiagnosticActionSchema),
  forks: z.array(DecisionForkSchema),
  quality: QualityAssessmentSchema,
  metrics: z.array(MetricEstimateSchema),
  warnings: z.array(CaseWarningSchema),
  coaching: CoachingReportSchema,
  skillMatches: z.array(SkillMatchSchema),
  executions: z.array(ModelExecutionWithUsageSchema),
});

type ValidSnapshot = z.output<typeof SnapshotSchema>;

function reject(path: string, message: string): never {
  throw new ValidationFailedError(`Invalid analysis snapshot: ${message}`, [{ path, message }]);
}

function requireUniqueIds(path: string, ids: readonly string[]): void {
  if (unique(ids).length !== ids.length) reject(path, 'Artefact ids must be unique');
}

/** Structural checks that do not need the database (consistency of ids, tenants and references). */
function validateSnapshot(ctx: RepoContext, snapshot: AnalysisSnapshot): ValidSnapshot {
  const s = validateInput(SnapshotSchema, snapshot, 'analysis snapshot');
  const { run } = s;
  if (run.status !== 'succeeded') {
    reject('run.status', 'Only a succeeded analysis run can be saved as a snapshot');
  }
  const limits: [string, number, number][] = [
    ['evidence', s.evidence.length, SNAPSHOT_LIMITS.evidence],
    ['links', s.links.length, SNAPSHOT_LIMITS.links],
    ['claims', s.claims.length, SNAPSHOT_LIMITS.claims],
    ['missing', s.missing.length, SNAPSHOT_LIMITS.missing],
    ['hypotheses', s.hypotheses.length, SNAPSHOT_LIMITS.hypotheses],
    ['actions', s.actions.length, SNAPSHOT_LIMITS.actions],
    ['forks', s.forks.length, SNAPSHOT_LIMITS.forks],
    ['metrics', s.metrics.length, SNAPSHOT_LIMITS.metrics],
    ['warnings', s.warnings.length, SNAPSHOT_LIMITS.warnings],
    ['skillMatches', s.skillMatches.length, SNAPSHOT_LIMITS.skillMatches],
    ['executions', s.executions.length, SNAPSHOT_LIMITS.executions],
  ];
  for (const [path, count, max] of limits) {
    if (count > max) reject(path, `At most ${max} ${path} can be stored per analysis`);
  }

  assertTenant(ctx, run.tenantId);
  const owned = [
    ...s.evidence,
    ...s.links,
    ...s.claims,
    ...s.hypotheses,
    ...s.actions,
    ...s.forks,
    ...s.metrics,
    ...s.warnings,
    ...s.skillMatches,
    s.quality,
  ];
  for (const entity of owned) {
    assertTenant(ctx, entity.tenantId);
    if (entity.caseId !== run.caseId)
      reject('caseId', "Every artefact must belong to the run's case");
  }
  const runBound = [
    ...s.evidence,
    ...s.links,
    ...s.claims,
    ...s.hypotheses,
    ...s.actions,
    ...s.forks,
    ...s.metrics,
    ...s.warnings,
    s.quality,
  ];
  for (const entity of runBound) {
    if (entity.analysisRunId !== run.id)
      reject('analysisRunId', 'Every artefact must reference the saved run');
  }
  if (s.twin.caseId !== run.caseId || s.twin.analysisRunId !== run.id) {
    reject('twin', 'The digital twin must belong to the saved run');
  }
  if (s.coaching.caseId !== run.caseId || s.coaching.analysisRunId !== run.id) {
    reject('coaching', 'The coaching report must belong to the saved run');
  }
  for (const execution of s.executions) {
    assertTenant(ctx, execution.tenantId);
    if (execution.caseId !== null && execution.caseId !== run.caseId) {
      reject('executions', "Executions must belong to the run's case");
    }
  }

  requireUniqueIds(
    'evidence',
    s.evidence.map((e) => e.id),
  );
  requireUniqueIds(
    'links',
    s.links.map((l) => l.id),
  );
  requireUniqueIds(
    'claims',
    s.claims.map((c) => c.id),
  );
  requireUniqueIds(
    'missing',
    s.missing.map((m) => m.id),
  );
  requireUniqueIds(
    'hypotheses',
    s.hypotheses.map((h) => h.id),
  );
  requireUniqueIds(
    'actions',
    s.actions.map((a) => a.id),
  );
  requireUniqueIds(
    'forks',
    s.forks.map((f) => f.id),
  );
  requireUniqueIds(
    'metrics',
    s.metrics.map((m) => m.id),
  );
  requireUniqueIds(
    'warnings',
    s.warnings.map((w) => w.id),
  );
  requireUniqueIds(
    'skillMatches',
    s.skillMatches.map((m) => m.id),
  );

  const evidenceIds = new Set(s.evidence.map((e) => e.id));
  const hypothesisIds = new Set(s.hypotheses.map((h) => h.id));
  for (const link of s.links) {
    if (!evidenceIds.has(link.evidenceId))
      reject('links', `Link ${link.id} cites unknown evidence`);
    if (!hypothesisIds.has(link.hypothesisId))
      reject('links', `Link ${link.id} cites an unknown hypothesis`);
  }
  return s;
}

interface Previous {
  claims: Map<string, Claim>;
  warnings: Map<string, CaseWarning>;
  forks: Map<string, DecisionFork>;
  matches: Map<string, SkillMatch>;
}

async function loadPrevious(tx: SqlExecutor, tenantId: string, caseId: string): Promise<Previous> {
  const read = async <T extends { id: string }>(
    table: string,
    schema: z.ZodType<T>,
    limit: number,
  ): Promise<Map<string, T>> => {
    const result = await tx.query<DataRow>(
      `SELECT data FROM ${table} WHERE tenant_id = $1 AND case_id = $2 LIMIT ${limit}`,
      [tenantId, caseId],
    );
    const map = new Map<string, T>();
    for (const row of result.rows) {
      const entity = parseStored(schema, row.data, table);
      map.set(entity.id, entity);
    }
    return map;
  };
  return {
    claims: await read('claims', ClaimSchema, SNAPSHOT_LIMITS.claims),
    warnings: await read('case_warnings', CaseWarningSchema, SNAPSHOT_LIMITS.warnings),
    forks: await read('decision_forks', DecisionForkSchema, SNAPSHOT_LIMITS.forks),
    matches: await read('skill_matches', SkillMatchSchema, SNAPSHOT_LIMITS.skillMatches),
  };
}

/**
 * Reviewer decisions survive a re-analysis for rows that keep their deterministic id: the new
 * analysis supplies the content, the previous row supplies what a human decided about it. Rows that
 * existed before also move to the next version, so a UI holding the old version gets a conflict.
 */
function carryForward(s: ValidSnapshot, previous: Previous): ValidSnapshot {
  const claims = s.claims.map((claim) => {
    const before = previous.claims.get(claim.id);
    if (!before) return claim;
    const reviewed = before.reviewState !== 'pending';
    return validateInput(
      ClaimSchema,
      {
        ...claim,
        // Flags only ever accumulate: a re-analysis must not silently drop a recorded concern.
        flags: unique([...before.flags, ...claim.flags]),
        ...(reviewed
          ? {
              category: before.reviewedCategory ?? claim.category,
              reviewedCategory: before.reviewedCategory,
              reviewState: before.reviewState,
              reviewReason: before.reviewReason,
              reviewedBy: before.reviewedBy,
              reviewedAt: before.reviewedAt,
            }
          : {}),
        createdAt: before.createdAt,
        createdBy: before.createdBy,
        version: before.version + 1,
      },
      'carried-forward claim',
    );
  });
  const warnings = s.warnings.map((warning) => {
    const before = previous.warnings.get(warning.id);
    if (!before) return warning;
    const dismissal = before.dismissal ?? warning.dismissal;
    return validateInput(
      CaseWarningSchema,
      {
        ...warning,
        dismissal,
        // A dismissed warning stays dismissed while its condition still fires; a resolved one stays resolved.
        state: before.dismissal && warning.state === 'open' ? 'dismissed' : warning.state,
        createdAt: before.createdAt,
        createdBy: before.createdBy,
        version: before.version + 1,
      },
      'carried-forward warning',
    );
  });
  const forks = s.forks.map((fork) => {
    const before = previous.forks.get(fork.id);
    if (!before) return fork;
    const reviewed = before.reviewState !== 'pending';
    return validateInput(
      DecisionForkSchema,
      {
        ...fork,
        ...(reviewed ? { reviewState: before.reviewState, reviewReason: before.reviewReason } : {}),
        createdAt: before.createdAt,
        createdBy: before.createdBy,
        version: before.version + 1,
      },
      'carried-forward fork',
    );
  });
  const skillMatches = s.skillMatches.map((match) => {
    const before = previous.matches.get(match.id);
    if (!before) return match;
    return validateInput(
      SkillMatchSchema,
      {
        ...match,
        ...(before.applied
          ? { applied: true, appliedAt: before.appliedAt, appliedBy: before.appliedBy }
          : {}),
        createdAt: before.createdAt,
        createdBy: before.createdBy,
        version: before.version + 1,
      },
      'carried-forward skill match',
    );
  });
  return { ...s, claims, warnings, forks, skillMatches };
}

/** Citation integrity: every cited event must exist in this case (the foreign keys are the backstop). */
async function assertCitedEventsExist(
  tx: SqlExecutor,
  tenantId: string,
  s: ValidSnapshot,
): Promise<void> {
  const cited = unique([
    ...s.evidence.map((e) => e.eventId),
    ...s.claims.flatMap((c) => (c.eventId ? [c.eventId] : [])),
    ...s.actions.map((a) => a.eventId),
    ...s.forks.map((f) => f.eventId),
  ]);
  if (cited.length === 0) return;
  const result = await tx.query<{ id: string }>(
    'SELECT id FROM case_events WHERE tenant_id = $1 AND case_id = $2 AND id = ANY($3::text[])',
    [tenantId, s.run.caseId, cited],
  );
  const found = new Set(result.rows.map((row) => row.id));
  const missing = cited.filter((id) => !found.has(id));
  if (missing.length > 0) {
    reject('events', `Unknown cited events: ${missing.slice(0, 5).join(', ')}`);
  }
}

const ARTEFACT_TABLES_IN_DELETE_ORDER = [
  'hypothesis_evidence_links',
  'claims',
  'missing_evidence',
  'diagnostic_actions',
  'decision_forks',
  'quality_assessments',
  'metric_estimates',
  'case_warnings',
  'coaching_reports',
  'skill_matches',
  'digital_twins',
  'evidence',
  'hypotheses',
] as const;

/**
 * Replaces the case's analysis artefacts with `snapshot` in ONE transaction, carrying reviewer state
 * forward, and points the case at the new run. Everything is validated before the first write.
 */
export async function saveAnalysisSnapshot(
  ctx: RepoContext,
  snapshot: AnalysisSnapshot,
): Promise<void> {
  const validated = validateSnapshot(ctx, snapshot);
  const { tenantId } = ctx.scope;
  const caseId = validated.run.caseId;

  await ctx.run(async (tx) => {
    // Serialises concurrent snapshots of the same case (and reads the case for its state update).
    const lockedCase = await loadVersioned(tx, {
      table: 'cases',
      key: { tenant_id: tenantId, id: caseId },
      schema: CaseSchema,
      what: 'Case',
      id: caseId,
    });
    await assertCitedEventsExist(tx, tenantId, validated);
    const s = carryForward(validated, await loadPrevious(tx, tenantId, caseId));

    for (const table of ARTEFACT_TABLES_IN_DELETE_ORDER) {
      await tx.query(`DELETE FROM ${table} WHERE tenant_id = $1 AND case_id = $2`, [
        tenantId,
        caseId,
      ]);
    }

    const createdAt = s.run.createdAt;
    await insertRows(tx, ANALYSIS_RUNS, [s.run], 'upsert');
    await insertRows(tx, DIGITAL_TWINS, [{ tenantId, twin: s.twin }]);
    await insertRows(tx, EVIDENCE, s.evidence);
    await insertRows(
      tx,
      HYPOTHESES,
      s.hypotheses.map((entity, ordinal) => ({ entity, ordinal })),
    );
    await insertRows(tx, LINKS, s.links);
    await insertRows(tx, CLAIMS, s.claims);
    await insertRows(
      tx,
      MISSING_EVIDENCE,
      s.missing.map((missing, ordinal) => ({
        tenantId,
        caseId,
        analysisRunId: s.run.id,
        missing,
        ordinal,
        createdAt,
      })),
    );
    await insertRows(tx, DIAGNOSTIC_ACTIONS, s.actions);
    await insertRows(tx, DECISION_FORKS, s.forks);
    await insertRows(tx, QUALITY_ASSESSMENTS, [s.quality]);
    await insertRows(
      tx,
      QUALITY_DIMENSIONS,
      s.quality.dimensions.map((dimension, ordinal) => ({
        tenantId,
        caseId,
        assessmentId: s.quality.id,
        dimension,
        ordinal,
      })),
    );
    await insertRows(
      tx,
      METRIC_ESTIMATES,
      s.metrics.map((entity, ordinal) => ({ entity, ordinal })),
    );
    await insertRows(tx, CASE_WARNINGS, s.warnings);
    await insertRows(tx, COACHING_REPORTS, [{ tenantId, report: s.coaching }]);
    await insertRows(
      tx,
      SKILL_MATCHES,
      s.skillMatches.map((entity, ordinal) => ({ entity, ordinal })),
    );
    await upsertExecutions(tx, ctx, s.executions);

    const updated = CaseSchema.parse({
      ...lockedCase.entity,
      analysisState: 'analyzed',
      lastAnalysisRunId: s.run.id,
      analyzedAt: s.run.completedAt ?? nowIso(ctx),
      updatedAt: nowIso(ctx),
      version: lockedCase.version + 1,
    });
    await updateRow(tx, CASES, updated, {
      columns: [
        'analysis_state',
        'last_analysis_run_id',
        'analyzed_at',
        'updated_at',
        'version',
        'data',
      ],
    });
  });
}
