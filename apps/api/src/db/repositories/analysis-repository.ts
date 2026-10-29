import {
  AnalysisRunSchema,
  CaseWarningSchema,
  ClaimSchema,
  CoachingReportSchema,
  DecisionForkSchema,
  DiagnosticActionSchema,
  DigitalTwinSchema,
  EVIDENCE_CATEGORIES,
  EvidenceSchema,
  HypothesisEvidenceLinkSchema,
  HypothesisSchema,
  MetricEstimateSchema,
  MissingEvidenceSchema,
  QualityAssessmentSchema,
  SkillMatchSchema,
  type AnalysisRun,
  type CaseWarning,
  type Claim,
  type CoachingReport,
  type DecisionFork,
  type DiagnosticAction,
  type DigitalTwin,
  type Evidence,
  type Hypothesis,
  type HypothesisEvidenceLink,
  type MetricEstimate,
  type MissingEvidence,
  type Page,
  type QualityAssessment,
  type ReviewState,
  type SkillMatch,
} from '@caseguard/schemas';
import type { z } from 'zod';
import { ConflictError } from '../../errors';
import { decodeCursor, encodeCursor, normalizeLimit, toPage } from '../cursor';
import {
  DismissSchema,
  ForkReviewSchema,
  ReviewClaimSchema,
  ensureUpdated,
} from './analysis-inputs';
import { SNAPSHOT_LIMITS, saveAnalysisSnapshot } from './analysis-snapshot';
import { CASE_WARNINGS, CLAIMS, DECISION_FORKS } from './table-specs';
import {
  QueryBuilder,
  assertVersion,
  loadVersioned,
  normalizeInstant,
  nowIso,
  parseStored,
  updateRow,
  validateInput,
  type DataRow,
  type RepoContext,
} from './support';
import type {
  AnalysisRepository,
  AnalysisSnapshot,
  ClaimQuery,
  DismissWarningInput,
  ReviewClaimInput,
} from './types';

export class AnalysisRepositoryImpl implements AnalysisRepository {
  constructor(private readonly ctx: RepoContext) {}

  private caseQuery(caseId: string): QueryBuilder {
    const q = new QueryBuilder();
    q.where(`tenant_id = ${q.bind(this.ctx.scope.tenantId)}`);
    q.where(`case_id = ${q.bind(caseId)}`);
    return q;
  }

  /** Reads `data` of every row matching the query, validated, in the given (code-owned) order. */
  private async select<S extends z.ZodType>(
    table: string,
    schema: S,
    what: string,
    q: QueryBuilder,
    order: string | null,
    limit: number,
  ): Promise<z.output<S>[]> {
    const orderBy = order ? ` ORDER BY ${order}` : '';
    return this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow>(
        `SELECT data FROM ${table} WHERE ${q.clause}${orderBy} LIMIT ${limit}`,
        q.params,
      );
      return result.rows.map((row) => parseStored(schema, row.data, what));
    });
  }

  private async selectOne<S extends z.ZodType>(
    table: string,
    schema: S,
    what: string,
    q: QueryBuilder,
    order: string | null = null,
  ): Promise<z.output<S> | null> {
    const rows = await this.select(table, schema, what, q, order, 1);
    return rows[0] ?? null;
  }

  async findRunByInputHash(caseId: string, inputHash: string): Promise<AnalysisRun | null> {
    const q = this.caseQuery(caseId);
    q.where(`input_hash = ${q.bind(inputHash)}`);
    return this.selectOne(
      'analysis_runs',
      AnalysisRunSchema,
      'analysis run',
      q,
      "(status = 'succeeded') DESC, started_at DESC, id DESC",
    );
  }

  async saveSnapshot(snapshot: AnalysisSnapshot): Promise<void> {
    await saveAnalysisSnapshot(this.ctx, snapshot);
  }

  async getLatestRun(caseId: string): Promise<AnalysisRun | null> {
    const pointed = await this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow>(
        `SELECT r.data FROM cases c
           JOIN analysis_runs r ON r.tenant_id = c.tenant_id AND r.case_id = c.id
                               AND r.id = c.last_analysis_run_id
          WHERE c.tenant_id = $1 AND c.id = $2`,
        [this.ctx.scope.tenantId, caseId],
      );
      return result.rows[0];
    });
    if (pointed) return parseStored(AnalysisRunSchema, pointed.data, 'analysis run');
    return this.selectOne(
      'analysis_runs',
      AnalysisRunSchema,
      'analysis run',
      this.caseQuery(caseId),
      'started_at DESC, id DESC',
    );
  }

  async getTwin(caseId: string): Promise<DigitalTwin | null> {
    return this.selectOne(
      'digital_twins',
      DigitalTwinSchema,
      'digital twin',
      this.caseQuery(caseId),
    );
  }

  async listEvidence(
    caseId: string,
    filter: { asOf?: string | undefined; ids?: readonly string[] | undefined } = {},
  ): Promise<Evidence[]> {
    if (filter.ids && filter.ids.length === 0) return [];
    const q = this.caseQuery(caseId);
    if (filter.asOf)
      q.where(`observed_at <= ${q.bind(normalizeInstant(filter.asOf, 'asOf'))}::timestamptz`);
    if (filter.ids) q.where(`id = ANY(${q.bind([...filter.ids])}::text[])`);
    return this.select(
      'evidence',
      EvidenceSchema,
      'evidence',
      q,
      'observed_at, id',
      SNAPSHOT_LIMITS.evidence,
    );
  }

  async listLinks(
    caseId: string,
    filter: { asOf?: string | undefined; hypothesisId?: string | undefined } = {},
  ): Promise<HypothesisEvidenceLink[]> {
    const q = this.caseQuery(caseId);
    if (filter.asOf)
      q.where(`observed_at <= ${q.bind(normalizeInstant(filter.asOf, 'asOf'))}::timestamptz`);
    if (filter.hypothesisId) q.where(`hypothesis_id = ${q.bind(filter.hypothesisId)}`);
    return this.select(
      'hypothesis_evidence_links',
      HypothesisEvidenceLinkSchema,
      'hypothesis link',
      q,
      'observed_at, id',
      SNAPSHOT_LIMITS.links,
    );
  }

  async listClaims(caseId: string, query: ClaimQuery): Promise<Page<Claim>> {
    const limit = normalizeLimit(query.limit);
    const cursor = decodeCursor('claims', query.cursor, ['timestamp', 'text']);
    const q = this.caseQuery(caseId);
    if (query.asOf)
      q.where(`claim_ts <= ${q.bind(normalizeInstant(query.asOf, 'asOf'))}::timestamptz`);
    if (query.category) q.where(`category = ${q.bind(query.category)}`);
    if (query.reviewState) q.where(`review_state = ${q.bind(query.reviewState)}`);
    if (query.hypothesisId)
      q.where(`${q.bind(query.hypothesisId)}::text = ANY(related_hypothesis_ids)`);
    const needle = query.q?.trim();
    if (needle) {
      const p = q.bind(needle);
      q.where(
        `(strpos(lower(data->>'text'), lower(${p}::text)) > 0
          OR strpos(lower(coalesce(subject, '')), lower(${p}::text)) > 0)`,
      );
    }
    if (cursor) {
      q.where(`(claim_ts, id) > (${q.bind(cursor[0])}::timestamptz, ${q.bind(cursor[1])}::text)`);
    }
    const limitParam = q.bind(limit + 1);
    const rows = await this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow & { sort_ts: string; id: string }>(
        `SELECT data, claim_ts AS sort_ts, id FROM claims WHERE ${q.clause}
          ORDER BY claim_ts, id LIMIT ${limitParam}::integer`,
        q.params,
      );
      return result.rows;
    });
    return toPage(
      rows,
      limit,
      (row) => parseStored(ClaimSchema, row.data, 'claim'),
      (row) => encodeCursor('claims', [row.sort_ts, row.id]),
    );
  }

  async countClaimsByCategory(caseId: string, asOf?: string): Promise<Record<string, number>> {
    const q = this.caseQuery(caseId);
    if (asOf) q.where(`claim_ts <= ${q.bind(normalizeInstant(asOf, 'asOf'))}::timestamptz`);
    const counts: Record<string, number> = Object.fromEntries(
      EVIDENCE_CATEGORIES.map((category) => [category, 0]),
    );
    const rows = await this.ctx.run(async (tx) => {
      const result = await tx.query<{ category: string; n: number }>(
        `SELECT category, count(*)::int AS n FROM claims WHERE ${q.clause} GROUP BY category`,
        q.params,
      );
      return result.rows;
    });
    for (const row of rows) counts[row.category] = row.n;
    return counts;
  }

  async getClaim(caseId: string, claimId: string): Promise<Claim | null> {
    const q = this.caseQuery(caseId);
    q.where(`id = ${q.bind(claimId)}`);
    return this.selectOne('claims', ClaimSchema, 'claim', q);
  }

  async reviewClaim(caseId: string, claimId: string, input: ReviewClaimInput): Promise<Claim> {
    const review = validateInput(ReviewClaimSchema, input, 'claim review');
    return this.ctx.run(async (tx) => {
      const { entity, version } = await loadVersioned(tx, {
        table: 'claims',
        key: { tenant_id: this.ctx.scope.tenantId, case_id: caseId, id: claimId },
        schema: ClaimSchema,
        what: 'Claim',
        id: claimId,
      });
      assertVersion('Claim', review.expectedVersion, version);
      // The original AI classification (aiCategory) is never touched; only the effective one changes.
      const next = validateInput(
        ClaimSchema,
        {
          ...entity,
          category: review.reviewedCategory,
          reviewedCategory: review.reviewedCategory,
          reviewState: review.reviewedCategory === entity.aiCategory ? 'confirmed' : 'corrected',
          reviewReason: review.reason,
          reviewedBy: review.reviewedBy,
          reviewedAt: review.reviewedAt,
          updatedAt: nowIso(this.ctx),
          version: version + 1,
        },
        'claim',
      );
      ensureUpdated(await updateRow(tx, CLAIMS, next, { expectedVersion: version }), 'Claim');
      return next;
    });
  }

  async listMissing(caseId: string): Promise<MissingEvidence[]> {
    return this.select(
      'missing_evidence',
      MissingEvidenceSchema,
      'missing evidence',
      this.caseQuery(caseId),
      'ordinal, first_relevant_at, id',
      SNAPSHOT_LIMITS.missing,
    );
  }

  async listHypotheses(caseId: string): Promise<Hypothesis[]> {
    return this.select(
      'hypotheses',
      HypothesisSchema,
      'hypothesis',
      this.caseQuery(caseId),
      'ordinal, id',
      SNAPSHOT_LIMITS.hypotheses,
    );
  }

  async listActions(caseId: string, asOf?: string): Promise<DiagnosticAction[]> {
    const q = this.caseQuery(caseId);
    if (asOf) q.where(`started_at <= ${q.bind(normalizeInstant(asOf, 'asOf'))}::timestamptz`);
    return this.select(
      'diagnostic_actions',
      DiagnosticActionSchema,
      'diagnostic action',
      q,
      'sequence, id',
      SNAPSHOT_LIMITS.actions,
    );
  }

  async listForks(caseId: string): Promise<DecisionFork[]> {
    return this.select(
      'decision_forks',
      DecisionForkSchema,
      'decision fork',
      this.caseQuery(caseId),
      'sequence, id',
      SNAPSHOT_LIMITS.forks,
    );
  }

  async getFork(caseId: string, forkId: string): Promise<DecisionFork | null> {
    const q = this.caseQuery(caseId);
    q.where(`id = ${q.bind(forkId)}`);
    return this.selectOne('decision_forks', DecisionForkSchema, 'decision fork', q);
  }

  async updateForkReview(
    caseId: string,
    forkId: string,
    review: { reviewState: ReviewState; reason: string | null; expectedVersion: number },
  ): Promise<DecisionFork> {
    const input = validateInput(ForkReviewSchema, review, 'fork review');
    return this.ctx.run(async (tx) => {
      const { entity, version } = await loadVersioned(tx, {
        table: 'decision_forks',
        key: { tenant_id: this.ctx.scope.tenantId, case_id: caseId, id: forkId },
        schema: DecisionForkSchema,
        what: 'Decision fork',
        id: forkId,
      });
      assertVersion('Decision fork', input.expectedVersion, version);
      const next = validateInput(
        DecisionForkSchema,
        {
          ...entity,
          reviewState: input.reviewState,
          reviewReason: input.reason,
          updatedAt: nowIso(this.ctx),
          version: version + 1,
        },
        'decision fork',
      );
      ensureUpdated(
        await updateRow(tx, DECISION_FORKS, next, { expectedVersion: version }),
        'Decision fork',
      );
      return next;
    });
  }

  async getQuality(caseId: string): Promise<QualityAssessment | null> {
    return this.selectOne(
      'quality_assessments',
      QualityAssessmentSchema,
      'quality assessment',
      this.caseQuery(caseId),
      'created_at DESC, id DESC',
    );
  }

  async listMetrics(caseId: string): Promise<MetricEstimate[]> {
    return this.select(
      'metric_estimates',
      MetricEstimateSchema,
      'metric estimate',
      this.caseQuery(caseId),
      'ordinal, key',
      SNAPSHOT_LIMITS.metrics,
    );
  }

  /**
   * Warnings raised at or before `asOf`. Resolution information that only became true after `asOf`
   * is withheld (the warning is shown open then), so a time-travel view never reveals the future.
   */
  async listWarnings(
    caseId: string,
    filter: {
      asOf?: string | undefined;
      state?: 'open' | 'resolved' | 'dismissed' | undefined;
    } = {},
  ): Promise<CaseWarning[]> {
    const asOf = filter.asOf ? normalizeInstant(filter.asOf, 'asOf') : null;
    const q = this.caseQuery(caseId);
    if (asOf) q.where(`raised_at <= ${q.bind(asOf)}::timestamptz`);
    const rows = await this.select(
      'case_warnings',
      CaseWarningSchema,
      'case warning',
      q,
      'rank, id',
      SNAPSHOT_LIMITS.warnings,
    );
    const visible = asOf
      ? rows.map((warning) =>
          warning.resolvedAt !== null && Date.parse(warning.resolvedAt) > Date.parse(asOf)
            ? {
                ...warning,
                resolvedAt: null,
                resolvedReason: null,
                state: warning.dismissal ? ('dismissed' as const) : ('open' as const),
              }
            : warning,
        )
      : rows;
    return filter.state ? visible.filter((warning) => warning.state === filter.state) : visible;
  }

  async getWarning(caseId: string, warningId: string): Promise<CaseWarning | null> {
    const q = this.caseQuery(caseId);
    q.where(`id = ${q.bind(warningId)}`);
    return this.selectOne('case_warnings', CaseWarningSchema, 'case warning', q);
  }

  async dismissWarning(
    caseId: string,
    warningId: string,
    input: DismissWarningInput,
  ): Promise<CaseWarning> {
    const dismissal = validateInput(DismissSchema, input, 'warning dismissal');
    return this.ctx.run(async (tx) => {
      const { entity, version } = await loadVersioned(tx, {
        table: 'case_warnings',
        key: { tenant_id: this.ctx.scope.tenantId, case_id: caseId, id: warningId },
        schema: CaseWarningSchema,
        what: 'Warning',
        id: warningId,
      });
      assertVersion('Warning', dismissal.expectedVersion, version);
      if (entity.state !== 'open') {
        throw new ConflictError(
          `Only open warnings can be dismissed; this warning is ${entity.state}`,
        );
      }
      const next = validateInput(
        CaseWarningSchema,
        {
          ...entity,
          state: 'dismissed',
          dismissal: { by: dismissal.by, at: dismissal.at, reason: dismissal.reason },
          updatedAt: nowIso(this.ctx),
          version: version + 1,
        },
        'warning dismissal',
      );
      ensureUpdated(
        await updateRow(tx, CASE_WARNINGS, next, { expectedVersion: version }),
        'Warning',
      );
      return next;
    });
  }

  async getCoaching(caseId: string): Promise<CoachingReport | null> {
    return this.selectOne(
      'coaching_reports',
      CoachingReportSchema,
      'coaching report',
      this.caseQuery(caseId),
    );
  }

  async listSkillMatches(caseId: string): Promise<SkillMatch[]> {
    return this.select(
      'skill_matches',
      SkillMatchSchema,
      'skill match',
      this.caseQuery(caseId),
      'ordinal, id',
      SNAPSHOT_LIMITS.skillMatches,
    );
  }
}
