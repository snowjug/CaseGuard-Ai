import {
  ActionRankingSchema,
  AnalysisRunSchema,
  CaseDetailSchema,
  CaseWarningSchema,
  CoachingReportSchema,
  CounterfactualScenarioSchema,
  DiagnosticActionSchema,
  ForkListResponseSchema,
  MetricEstimateSchema,
  ProvenanceResponseSchema,
  QualityAssessmentSchema,
  SkillMatchSchema,
  SkillOverlaySchema,
  TimelineResponseSchema,
  type ActionRanking,
  type AnalysisRun,
  type CaseDetail,
  type CaseWarning,
  type CoachingReport,
  type CounterfactualScenario,
  type DiagnosticAction,
  type ForkListResponse,
  type MetricEstimate,
  type ProvenanceResponse,
  type QualityAssessment,
  type SkillMatch,
  type SkillOverlay,
  type TimelineResponse,
} from '@caseguard/schemas';
import { z } from 'zod';
import caseOneJson from './fixtures/review/case-one.json';
import caseTwoJson from './fixtures/review/case-two.json';
import overlayJson from './fixtures/review/skill-overlay.json';
import provenanceJson from './fixtures/review/provenance-case-one.json';

/**
 * The real engine output of the two samples (CG-SYN-1001 and CG-SYN-1002), captured from the in-process API with the
 * guided demo story played, then trimmed (see fixtures/review/README.md). Every response is validated with the real
 * Zod schema of its route, so a fixture can never drift from the contract the screens read.
 */

export interface CaseFixture {
  detail: CaseDetail;
  run: AnalysisRun;
  timeline: TimelineResponse;
  forks: ForkListResponse;
  scenarios: CounterfactualScenario[];
  quality: QualityAssessment;
  metrics: MetricEstimate[];
  warnings: CaseWarning[];
  coaching: CoachingReport;
  ranking: ActionRanking;
  actions: DiagnosticAction[];
  matches: SkillMatch[];
}

const Items = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item) });

function load(raw: unknown): CaseFixture {
  const json = raw as Record<string, unknown>;
  const run = z.object({ run: AnalysisRunSchema }).parse(json['analysis.latest']).run;
  return {
    detail: CaseDetailSchema.parse(json['cases.get']),
    run,
    timeline: TimelineResponseSchema.parse(json['timeline.get']),
    forks: ForkListResponseSchema.parse(json['forks.list']),
    scenarios: Items(CounterfactualScenarioSchema).parse(json['counterfactuals.list']).items,
    quality: QualityAssessmentSchema.parse(json['quality.get']),
    metrics: Items(MetricEstimateSchema).parse(json['metrics.get']).items,
    warnings: Items(CaseWarningSchema).parse(json['warnings.list']).items,
    coaching: CoachingReportSchema.parse(json['coaching.get']),
    ranking: ActionRankingSchema.parse(json['actionValue.rank']),
    actions: Items(DiagnosticActionSchema).parse(json['actions.list']).items,
    matches: Items(SkillMatchSchema).parse(json['skillMatches.list']).items,
  };
}

/** Case One: a costly investigation with nine decision points, a reviewer-accepted better path and 14 warnings. */
export const CASE_ONE: CaseFixture = load(caseOneJson);
/** Case Two: an efficient follow-up with no decision point, no warning and a published skill that matched. */
export const CASE_TWO: CaseFixture = load(caseTwoJson);

/** Hand-built to the `provenance.resolve` contract with quotations cut from the real text of Case One. */
export const PROVENANCE_ONE: ProvenanceResponse = ProvenanceResponseSchema.parse(provenanceJson);

/** Hand-built to the `skillOverlay.get` contract (the handler is a separate workstream); estimates, not measurements. */
export const OVERLAY_ONE: SkillOverlay = SkillOverlaySchema.parse(overlayJson.caseOne);
export const OVERLAY_TWO: SkillOverlay = SkillOverlaySchema.parse(overlayJson.caseTwo);
