import {
  AvoidableEffortDetailsSchema,
  CaseSchema,
  ReviewStateSchema,
  SkillDnaSchema,
} from '@caseguard/schemas';
import { z } from 'zod';
import { ValidationFailedError } from '../../errors';
import { parseStored, type DataRow, type RepoContext } from './support';
import type { AnalyticsRepository, AnalyticsSource } from './types';

const MAX_CASES = 500;
/** Rows per artefact kind; generous for 500 cases yet keeps the read model bounded. */
const MAX_ROWS = 20_000;
const MAX_SKILLS = 500;

const QualityRow = z.object({
  case_id: z.string(),
  analyzed_at: z.string(),
  composite_score: z.number(),
  evidence_integrity: z.number(),
});
const ForkRow = z.object({ case_id: z.string(), category: z.string() });
const MissingRow = z.object({
  case_id: z.string(),
  requirement_id: z.string(),
  label: z.string(),
  resolved: z.boolean(),
});
const MetricRow = z.object({
  case_id: z.string(),
  key: z.string(),
  value: z.number().nullable(),
  ase: AvoidableEffortDetailsSchema.nullable(),
});
const FlagRow = z.object({
  case_id: z.string(),
  subject: z.string().nullable(),
  text: z.string(),
});
const ScenarioRow = z.object({
  case_id: z.string(),
  review_state: ReviewStateSchema,
  counterfactual_tokens: z.number(),
  actual_tokens: z.number(),
});
const MatchRow = z.object({ case_id: z.string(), skill_id: z.string(), applied: z.boolean() });

export class AnalyticsRepositoryImpl implements AnalyticsRepository {
  constructor(private readonly ctx: RepoContext) {}

  async collect(limit: number): Promise<AnalyticsSource> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CASES) {
      throw new ValidationFailedError(`limit must be an integer between 1 and ${MAX_CASES}`, [
        { path: 'limit', message: `Use a value between 1 and ${MAX_CASES}` },
      ]);
    }
    const { tenantId } = this.ctx.scope;
    return this.ctx.run(async (tx) => {
      const caseRows = await tx.query<DataRow>(
        'SELECT data FROM cases WHERE tenant_id = $1 ORDER BY opened_at DESC, id DESC LIMIT $2::integer',
        [tenantId, limit],
      );
      const cases = caseRows.rows.map((row) => parseStored(CaseSchema, row.data, 'case'));
      const ids = cases.map((c) => c.id);

      const skillRows = await tx.query<DataRow>(
        `SELECT data FROM skills WHERE tenant_id = $1 ORDER BY updated_at DESC, id DESC LIMIT ${MAX_SKILLS}`,
        [tenantId],
      );
      const skills = skillRows.rows.map((row) => parseStored(SkillDnaSchema, row.data, 'skill'));
      if (ids.length === 0) {
        return {
          cases: [],
          quality: [],
          forks: [],
          missing: [],
          metrics: [],
          assumptionFlags: [],
          scenarios: [],
          skills,
          matches: [],
        };
      }

      const params = [tenantId, ids];
      const quality = await tx.query(
        `SELECT DISTINCT ON (q.case_id)
                q.case_id AS case_id,
                coalesce(c.analyzed_at, q.created_at) AS analyzed_at,
                q.composite_score AS composite_score,
                d.score AS evidence_integrity
           FROM quality_assessments q
           JOIN cases c ON c.tenant_id = q.tenant_id AND c.id = q.case_id
           JOIN quality_dimensions d ON d.tenant_id = q.tenant_id AND d.case_id = q.case_id
                                    AND d.assessment_id = q.id AND d.key = 'evidence_integrity'
          WHERE q.tenant_id = $1 AND q.case_id = ANY($2::text[])
          ORDER BY q.case_id, q.created_at DESC, q.id DESC`,
        params,
      );
      const forks = await tx.query(
        `SELECT case_id, category FROM decision_forks
          WHERE tenant_id = $1 AND case_id = ANY($2::text[]) ORDER BY case_id, sequence LIMIT ${MAX_ROWS}`,
        params,
      );
      const missing = await tx.query(
        `SELECT case_id, requirement_id, data->>'label' AS label, (resolved_at IS NOT NULL) AS resolved
           FROM missing_evidence
          WHERE tenant_id = $1 AND case_id = ANY($2::text[]) ORDER BY case_id, ordinal LIMIT ${MAX_ROWS}`,
        params,
      );
      const metrics = await tx.query(
        `SELECT case_id, key, value, data->'ase' AS ase FROM metric_estimates
          WHERE tenant_id = $1 AND case_id = ANY($2::text[]) ORDER BY case_id, ordinal LIMIT ${MAX_ROWS}`,
        params,
      );
      const flags = await tx.query(
        `SELECT case_id, subject, data->>'text' AS text FROM claims
          WHERE tenant_id = $1 AND case_id = ANY($2::text[]) AND 'assumption_as_fact' = ANY(flags)
          ORDER BY case_id, claim_ts, id LIMIT ${MAX_ROWS}`,
        params,
      );
      const scenarios = await tx.query(
        `SELECT case_id, review_state, counterfactual_tokens, actual_tokens FROM counterfactual_scenarios
          WHERE tenant_id = $1 AND case_id = ANY($2::text[]) ORDER BY case_id, created_at, id LIMIT ${MAX_ROWS}`,
        params,
      );
      const matches = await tx.query(
        `SELECT case_id, skill_id, applied FROM skill_matches
          WHERE tenant_id = $1 AND case_id = ANY($2::text[]) ORDER BY case_id, ordinal, id LIMIT ${MAX_ROWS}`,
        params,
      );

      return {
        cases: cases.map((c) => ({
          id: c.id,
          reference: c.reference,
          synthetic: c.synthetic,
          analysisState: c.analysisState,
          openedAt: c.openedAt,
          workload: c.workload,
        })),
        quality: quality.rows.map((row) => {
          const parsed = parseStored(QualityRow, row, 'analytics quality row');
          return {
            caseId: parsed.case_id,
            analyzedAt: parsed.analyzed_at,
            compositeScore: parsed.composite_score,
            evidenceIntegrity: parsed.evidence_integrity,
          };
        }),
        forks: forks.rows.map((row) => {
          const parsed = parseStored(ForkRow, row, 'analytics fork row');
          return { caseId: parsed.case_id, category: parsed.category };
        }),
        missing: missing.rows.map((row) => {
          const parsed = parseStored(MissingRow, row, 'analytics missing-evidence row');
          return {
            caseId: parsed.case_id,
            requirementId: parsed.requirement_id,
            label: parsed.label,
            resolved: parsed.resolved,
          };
        }),
        metrics: metrics.rows.map((row) => {
          const parsed = parseStored(MetricRow, row, 'analytics metric row');
          return {
            caseId: parsed.case_id,
            key: parsed.key,
            value: parsed.value,
            ase: parsed.ase
              ? {
                  components: parsed.ase.components.map((component) => ({
                    key: component.key,
                    label: component.label,
                    avoidablePct: component.avoidablePct,
                  })),
                }
              : null,
          };
        }),
        assumptionFlags: flags.rows.map((row) => {
          const parsed = parseStored(FlagRow, row, 'analytics assumption row');
          return { caseId: parsed.case_id, subject: parsed.subject, text: parsed.text };
        }),
        scenarios: scenarios.rows.map((row) => {
          const parsed = parseStored(ScenarioRow, row, 'analytics scenario row');
          return {
            caseId: parsed.case_id,
            reviewState: parsed.review_state,
            counterfactualTokens: parsed.counterfactual_tokens,
            actualTokens: parsed.actual_tokens,
          };
        }),
        skills,
        matches: matches.rows.map((row) => {
          const parsed = parseStored(MatchRow, row, 'analytics match row');
          return { caseId: parsed.case_id, skillId: parsed.skill_id, applied: parsed.applied };
        }),
      };
    });
  }
}
