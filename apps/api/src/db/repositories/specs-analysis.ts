import type {
  AnalysisRun,
  CaseWarning,
  Claim,
  CoachingReport,
  CounterfactualScenario,
  CounterfactualStep,
  DecisionFork,
  DiagnosticAction,
  DigitalTwin,
  Evidence,
  Hypothesis,
  HypothesisEvidenceLink,
  MetricEstimate,
  MissingEvidence,
  QualityAssessment,
  QualityDimension,
} from '@caseguard/schemas';
import type { Ordered } from './specs-core';
import { col, ts, tsOrNull, type TableSpec } from './support';

/** Table projections for analysis artefacts and counterfactual scenarios (see specs-core.ts). */

// ------------------------------------------------------------------ analysis artefacts

export const ANALYSIS_RUNS: TableSpec<AnalysisRun> = {
  table: 'analysis_runs',
  key: ['tenant_id', 'case_id', 'id'],
  columns: [
    col('tenant_id', 'text', (r: AnalysisRun) => r.tenantId),
    col('case_id', 'text', (r) => r.caseId),
    col('id', 'text', (r) => r.id),
    col('status', 'text', (r) => r.status),
    col('provider', 'text', (r) => r.provider),
    col('model', 'text', (r) => r.model),
    col('input_hash', 'text', (r) => r.inputHash),
    col('started_at', 'timestamptz', (r) => ts(r.startedAt)),
    col('completed_at', 'timestamptz', (r) => tsOrNull(r.completedAt)),
    col('created_at', 'timestamptz', (r) => ts(r.createdAt)),
    col('updated_at', 'timestamptz', (r) => ts(r.updatedAt)),
    col('created_by', 'text', (r) => r.createdBy),
    col('version', 'int', (r) => r.version),
    col('data', 'jsonb', (r) => r),
  ],
};

export interface TwinRow {
  tenantId: string;
  twin: DigitalTwin;
}

export const DIGITAL_TWINS: TableSpec<TwinRow> = {
  table: 'digital_twins',
  key: ['tenant_id', 'case_id'],
  columns: [
    col('tenant_id', 'text', (r: TwinRow) => r.tenantId),
    col('case_id', 'text', (r) => r.twin.caseId),
    col('analysis_run_id', 'text', (r) => r.twin.analysisRunId),
    col('as_of', 'timestamptz', (r) => tsOrNull(r.twin.asOf)),
    col('generated_at', 'timestamptz', (r) => ts(r.twin.generatedAt)),
    col('data', 'jsonb', (r) => r.twin),
  ],
};

export const EVIDENCE: TableSpec<Evidence> = {
  table: 'evidence',
  key: ['tenant_id', 'case_id', 'id'],
  columns: [
    col('tenant_id', 'text', (e: Evidence) => e.tenantId),
    col('case_id', 'text', (e) => e.caseId),
    col('id', 'text', (e) => e.id),
    col('analysis_run_id', 'text', (e) => e.analysisRunId),
    col('signal_id', 'text', (e) => e.signalId),
    col('kind', 'text', (e) => e.kind),
    col('strength', 'text', (e) => e.strength),
    col('category', 'text', (e) => e.category),
    col('event_id', 'text', (e) => e.eventId),
    col('observed_at', 'timestamptz', (e) => ts(e.observedAt)),
    col('confidence', 'float8', (e) => e.confidence),
    col('created_at', 'timestamptz', (e) => ts(e.createdAt)),
    col('updated_at', 'timestamptz', (e) => ts(e.updatedAt)),
    col('created_by', 'text', (e) => e.createdBy),
    col('version', 'int', (e) => e.version),
    col('data', 'jsonb', (e) => e),
  ],
};

export const HYPOTHESES: TableSpec<Ordered<Hypothesis>> = {
  table: 'hypotheses',
  key: ['tenant_id', 'case_id', 'id'],
  columns: [
    col('tenant_id', 'text', (r: Ordered<Hypothesis>) => r.entity.tenantId),
    col('case_id', 'text', (r) => r.entity.caseId),
    col('id', 'text', (r) => r.entity.id),
    col('analysis_run_id', 'text', (r) => r.entity.analysisRunId),
    col('key', 'text', (r) => r.entity.key),
    col('name', 'text', (r) => r.entity.name),
    col('category', 'text', (r) => r.entity.category),
    col('prior', 'float8', (r) => r.entity.prior),
    col('current_confidence', 'float8', (r) => r.entity.currentConfidence),
    col('current_status', 'text', (r) => r.entity.currentStatus),
    col('ordinal', 'int', (r) => r.ordinal),
    col('created_at', 'timestamptz', (r) => ts(r.entity.createdAt)),
    col('updated_at', 'timestamptz', (r) => ts(r.entity.updatedAt)),
    col('created_by', 'text', (r) => r.entity.createdBy),
    col('version', 'int', (r) => r.entity.version),
    col('data', 'jsonb', (r) => r.entity),
  ],
};

export const LINKS: TableSpec<HypothesisEvidenceLink> = {
  table: 'hypothesis_evidence_links',
  key: ['tenant_id', 'case_id', 'id'],
  columns: [
    col('tenant_id', 'text', (l: HypothesisEvidenceLink) => l.tenantId),
    col('case_id', 'text', (l) => l.caseId),
    col('id', 'text', (l) => l.id),
    col('analysis_run_id', 'text', (l) => l.analysisRunId),
    col('hypothesis_id', 'text', (l) => l.hypothesisId),
    col('evidence_id', 'text', (l) => l.evidenceId),
    col('polarity', 'text', (l) => l.polarity),
    col('likelihood', 'float8', (l) => l.likelihood),
    col('log_likelihood_ratio', 'float8', (l) => l.logLikelihoodRatio),
    col('effect_on_confidence', 'float8', (l) => l.effectOnConfidence),
    col('observed_at', 'timestamptz', (l) => ts(l.observedAt)),
    col('created_at', 'timestamptz', (l) => ts(l.createdAt)),
    col('updated_at', 'timestamptz', (l) => ts(l.updatedAt)),
    col('created_by', 'text', (l) => l.createdBy),
    col('version', 'int', (l) => l.version),
    col('data', 'jsonb', (l) => l),
  ],
};

export const CLAIMS: TableSpec<Claim> = {
  table: 'claims',
  key: ['tenant_id', 'case_id', 'id'],
  columns: [
    col('tenant_id', 'text', (c: Claim) => c.tenantId),
    col('case_id', 'text', (c) => c.caseId),
    col('id', 'text', (c) => c.id),
    col('analysis_run_id', 'text', (c) => c.analysisRunId),
    col('category', 'text', (c) => c.category),
    col('ai_category', 'text', (c) => c.aiCategory),
    col('reviewed_category', 'text', (c) => c.reviewedCategory),
    col('review_state', 'text', (c) => c.reviewState),
    col('review_reason', 'text', (c) => c.reviewReason),
    col('reviewed_by', 'text', (c) => c.reviewedBy),
    col('reviewed_at', 'timestamptz', (c) => tsOrNull(c.reviewedAt)),
    col('subject', 'text', (c) => c.subject),
    col('author_role', 'text', (c) => c.authorRole),
    col('event_id', 'text', (c) => c.eventId),
    col('claim_ts', 'timestamptz', (c) => ts(c.timestamp)),
    col('confidence', 'float8', (c) => c.confidence),
    col('flags', 'text[]', (c) => c.flags),
    col('related_hypothesis_ids', 'text[]', (c) => c.relatedHypothesisIds),
    col('simulated', 'bool', (c) => c.simulated),
    col('created_at', 'timestamptz', (c) => ts(c.createdAt)),
    col('updated_at', 'timestamptz', (c) => ts(c.updatedAt)),
    col('created_by', 'text', (c) => c.createdBy),
    col('version', 'int', (c) => c.version),
    col('data', 'jsonb', (c) => c),
  ],
};

export interface MissingRow {
  tenantId: string;
  caseId: string;
  analysisRunId: string;
  missing: MissingEvidence;
  ordinal: number;
  createdAt: string;
}

export const MISSING_EVIDENCE: TableSpec<MissingRow> = {
  table: 'missing_evidence',
  key: ['tenant_id', 'case_id', 'id'],
  columns: [
    col('tenant_id', 'text', (r: MissingRow) => r.tenantId),
    col('case_id', 'text', (r) => r.caseId),
    col('id', 'text', (r) => r.missing.id),
    col('analysis_run_id', 'text', (r) => r.analysisRunId),
    col('requirement_id', 'text', (r) => r.missing.requirementId),
    col('criticality', 'text', (r) => r.missing.criticality),
    col('category', 'text', (r) => r.missing.category),
    col('first_relevant_at', 'timestamptz', (r) => ts(r.missing.firstRelevantAt)),
    col('resolved_at', 'timestamptz', (r) => tsOrNull(r.missing.resolvedAt)),
    col('ordinal', 'int', (r) => r.ordinal),
    col('created_at', 'timestamptz', (r) => ts(r.createdAt)),
    col('data', 'jsonb', (r) => r.missing),
  ],
};

export const DIAGNOSTIC_ACTIONS: TableSpec<DiagnosticAction> = {
  table: 'diagnostic_actions',
  key: ['tenant_id', 'case_id', 'id'],
  columns: [
    col('tenant_id', 'text', (a: DiagnosticAction) => a.tenantId),
    col('case_id', 'text', (a) => a.caseId),
    col('id', 'text', (a) => a.id),
    col('analysis_run_id', 'text', (a) => a.analysisRunId),
    col('event_id', 'text', (a) => a.eventId),
    col('sequence', 'int', (a) => a.sequence),
    col('action_key', 'text', (a) => a.actionKey),
    col('kind', 'text', (a) => a.kind),
    col('executor_role', 'text', (a) => a.executorRole),
    col('started_at', 'timestamptz', (a) => ts(a.startedAt)),
    col('destructive', 'bool', (a) => a.destructive),
    col('is_repeat', 'bool', (a) => a.isRepeat),
    col('low_value', 'bool', (a) => a.lowValue),
    col('created_at', 'timestamptz', (a) => ts(a.createdAt)),
    col('updated_at', 'timestamptz', (a) => ts(a.updatedAt)),
    col('created_by', 'text', (a) => a.createdBy),
    col('version', 'int', (a) => a.version),
    col('data', 'jsonb', (a) => a),
  ],
};

export const DECISION_FORKS: TableSpec<DecisionFork> = {
  table: 'decision_forks',
  key: ['tenant_id', 'case_id', 'id'],
  columns: [
    col('tenant_id', 'text', (f: DecisionFork) => f.tenantId),
    col('case_id', 'text', (f) => f.caseId),
    col('id', 'text', (f) => f.id),
    col('analysis_run_id', 'text', (f) => f.analysisRunId),
    col('sequence', 'int', (f) => f.sequence),
    col('fork_ts', 'timestamptz', (f) => ts(f.timestamp)),
    col('event_id', 'text', (f) => f.eventId),
    col('category', 'text', (f) => f.category),
    col('severity', 'text', (f) => f.severity),
    col('impact_score', 'float8', (f) => f.impactScore),
    col('is_earliest_meaningful', 'bool', (f) => f.isEarliestMeaningful),
    col('review_state', 'text', (f) => f.reviewState),
    col('review_reason', 'text', (f) => f.reviewReason),
    col('created_at', 'timestamptz', (f) => ts(f.createdAt)),
    col('updated_at', 'timestamptz', (f) => ts(f.updatedAt)),
    col('created_by', 'text', (f) => f.createdBy),
    col('version', 'int', (f) => f.version),
    col('data', 'jsonb', (f) => f),
  ],
};

export const QUALITY_ASSESSMENTS: TableSpec<QualityAssessment> = {
  table: 'quality_assessments',
  key: ['tenant_id', 'case_id', 'id'],
  columns: [
    col('tenant_id', 'text', (q: QualityAssessment) => q.tenantId),
    col('case_id', 'text', (q) => q.caseId),
    col('id', 'text', (q) => q.id),
    col('analysis_run_id', 'text', (q) => q.analysisRunId),
    col('as_of', 'timestamptz', (q) => tsOrNull(q.asOf)),
    col('composite_score', 'float8', (q) => q.compositeScore),
    col('composite_low', 'float8', (q) => q.compositeLow),
    col('composite_high', 'float8', (q) => q.compositeHigh),
    col('band', 'text', (q) => q.band),
    col('created_at', 'timestamptz', (q) => ts(q.createdAt)),
    col('updated_at', 'timestamptz', (q) => ts(q.updatedAt)),
    col('created_by', 'text', (q) => q.createdBy),
    col('version', 'int', (q) => q.version),
    col('data', 'jsonb', (q) => q),
  ],
};

export interface DimensionRow {
  tenantId: string;
  caseId: string;
  assessmentId: string;
  dimension: QualityDimension;
  ordinal: number;
}

export const QUALITY_DIMENSIONS: TableSpec<DimensionRow> = {
  table: 'quality_dimensions',
  key: ['tenant_id', 'case_id', 'assessment_id', 'key'],
  columns: [
    col('tenant_id', 'text', (r: DimensionRow) => r.tenantId),
    col('case_id', 'text', (r) => r.caseId),
    col('assessment_id', 'text', (r) => r.assessmentId),
    col('key', 'text', (r) => r.dimension.key),
    col('ordinal', 'int', (r) => r.ordinal),
    col('weight', 'float8', (r) => r.dimension.weight),
    col('raw_score', 'float8', (r) => r.dimension.rawScore),
    col('penalty_points', 'float8', (r) => r.dimension.penaltyPoints),
    col('score', 'float8', (r) => r.dimension.score),
    col('low', 'float8', (r) => r.dimension.low),
    col('high', 'float8', (r) => r.dimension.high),
    col('data', 'jsonb', (r) => r.dimension),
  ],
};

export const METRIC_ESTIMATES: TableSpec<Ordered<MetricEstimate>> = {
  table: 'metric_estimates',
  key: ['tenant_id', 'case_id', 'id'],
  columns: [
    col('tenant_id', 'text', (r: Ordered<MetricEstimate>) => r.entity.tenantId),
    col('case_id', 'text', (r) => r.entity.caseId),
    col('id', 'text', (r) => r.entity.id),
    col('analysis_run_id', 'text', (r) => r.entity.analysisRunId),
    col('key', 'text', (r) => r.entity.key),
    col('value', 'float8', (r) => r.entity.value),
    col('unit', 'text', (r) => r.entity.unit),
    col('status', 'text', (r) => r.entity.status),
    col('confidence', 'text', (r) => r.entity.confidence),
    col('synthetic', 'bool', (r) => r.entity.synthetic),
    col('ordinal', 'int', (r) => r.ordinal),
    col('created_at', 'timestamptz', (r) => ts(r.entity.createdAt)),
    col('updated_at', 'timestamptz', (r) => ts(r.entity.updatedAt)),
    col('created_by', 'text', (r) => r.entity.createdBy),
    col('version', 'int', (r) => r.entity.version),
    col('data', 'jsonb', (r) => r.entity),
  ],
};

export const CASE_WARNINGS: TableSpec<CaseWarning> = {
  table: 'case_warnings',
  key: ['tenant_id', 'case_id', 'id'],
  columns: [
    col('tenant_id', 'text', (w: CaseWarning) => w.tenantId),
    col('case_id', 'text', (w) => w.caseId),
    col('id', 'text', (w) => w.id),
    col('analysis_run_id', 'text', (w) => w.analysisRunId),
    col('rule_id', 'text', (w) => w.ruleId),
    col('category', 'text', (w) => w.category),
    col('priority', 'text', (w) => w.priority),
    col('rank', 'int', (w) => w.rank),
    col('fingerprint', 'text', (w) => w.fingerprint),
    col('raised_at', 'timestamptz', (w) => ts(w.raisedAt)),
    col('resolved_at', 'timestamptz', (w) => tsOrNull(w.resolvedAt)),
    col('state', 'text', (w) => w.state),
    col('dismissed_by', 'text', (w) => w.dismissal?.by ?? null),
    col('dismissed_at', 'timestamptz', (w) => tsOrNull(w.dismissal?.at)),
    col('created_at', 'timestamptz', (w) => ts(w.createdAt)),
    col('updated_at', 'timestamptz', (w) => ts(w.updatedAt)),
    col('created_by', 'text', (w) => w.createdBy),
    col('version', 'int', (w) => w.version),
    col('data', 'jsonb', (w) => w),
  ],
};

export interface CoachingRow {
  tenantId: string;
  report: CoachingReport;
}

export const COACHING_REPORTS: TableSpec<CoachingRow> = {
  table: 'coaching_reports',
  key: ['tenant_id', 'case_id'],
  columns: [
    col('tenant_id', 'text', (r: CoachingRow) => r.tenantId),
    col('case_id', 'text', (r) => r.report.caseId),
    col('analysis_run_id', 'text', (r) => r.report.analysisRunId),
    col('generated_at', 'timestamptz', (r) => ts(r.report.generatedAt)),
    col('data', 'jsonb', (r) => r.report),
  ],
};

// ------------------------------------------------------------------ counterfactuals

export const COUNTERFACTUAL_SCENARIOS: TableSpec<CounterfactualScenario> = {
  table: 'counterfactual_scenarios',
  key: ['tenant_id', 'case_id', 'id'],
  columns: [
    col('tenant_id', 'text', (s: CounterfactualScenario) => s.tenantId),
    col('case_id', 'text', (s) => s.caseId),
    col('id', 'text', (s) => s.id),
    col('fork_id', 'text', (s) => s.forkId),
    col('analysis_run_id', 'text', (s) => s.analysisRunId),
    col('model_execution_id', 'text', (s) => s.modelExecutionId),
    col('status', 'text', (s) => s.status),
    col('strategy', 'text', (s) => s.strategy),
    col('as_of', 'timestamptz', (s) => ts(s.boundary.asOf)),
    col('review_state', 'text', (s) => s.reviewState),
    col('review_reason', 'text', (s) => s.reviewReason),
    col('reviewed_by', 'text', (s) => s.reviewedBy),
    col('reviewed_at', 'timestamptz', (s) => tsOrNull(s.reviewedAt)),
    col('actual_tokens', 'float8', (s) => s.actualMetrics.tokenEstimate.mid),
    col('counterfactual_tokens', 'float8', (s) => s.counterfactualMetrics.tokenEstimate.mid),
    col('created_at', 'timestamptz', (s) => ts(s.createdAt)),
    col('updated_at', 'timestamptz', (s) => ts(s.updatedAt)),
    col('created_by', 'text', (s) => s.createdBy),
    col('version', 'int', (s) => s.version),
    col('data', 'jsonb', (s) => s),
  ],
};

export interface StepRow {
  tenantId: string;
  caseId: string;
  step: CounterfactualStep;
}

export const COUNTERFACTUAL_STEPS: TableSpec<StepRow> = {
  table: 'counterfactual_steps',
  key: ['tenant_id', 'case_id', 'scenario_id', 'id'],
  columns: [
    col('tenant_id', 'text', (r: StepRow) => r.tenantId),
    col('case_id', 'text', (r) => r.caseId),
    col('scenario_id', 'text', (r) => r.step.scenarioId),
    col('id', 'text', (r) => r.step.id),
    col('step_index', 'int', (r) => r.step.index),
    col('simulated_at', 'timestamptz', (r) => ts(r.step.simulatedAt)),
    col('action_key', 'text', (r) => r.step.actionKey),
    col('kind', 'text', (r) => r.step.kind),
    col('data', 'jsonb', (r) => r.step),
  ],
};
