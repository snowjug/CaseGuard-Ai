import {
  AnalysisRunSchema,
  AuditEventSchema,
  CaseEventSchema,
  CaseParticipantSchema,
  CaseResolutionSchema,
  CaseSchema,
  CaseSourceSchema,
  CaseWarningSchema,
  ClaimSchema,
  CoachingReportSchema,
  CounterfactualScenarioSchema,
  DecisionForkSchema,
  DiagnosticActionSchema,
  DigitalTwinSchema,
  EvidenceSchema,
  HypothesisEvidenceLinkSchema,
  HypothesisSchema,
  JobSchema,
  MetricEstimateSchema,
  MissingEvidenceSchema,
  ModelExecutionWithUsageSchema,
  PromptVersionSchema,
  QualityAssessmentSchema,
  ReviewDecisionSchema,
  SkillApprovalSchema,
  SkillDnaSchema,
  SkillMatchSchema,
  SkillValidationSchema,
  SkillVersionSchema,
  UserSchema,
} from '@caseguard/schemas';
import { describe, expect, it } from 'vitest';
import { computeAuditHash, AUDIT_GENESIS_HASH } from '../src/db/repositories/audit-repository';
import { sha256Hex } from '../src/db/hash';
import {
  buildAction,
  buildAnalysisRun,
  buildCase,
  buildCaseEvent,
  buildCaseSource,
  buildClaim,
  buildCoaching,
  buildDigitalTwin,
  buildEvidence,
  buildExecution,
  buildFork,
  buildHypothesis,
  buildIngestInput,
  buildJob,
  buildLink,
  buildMetric,
  buildMissingEvidence,
  buildParticipant,
  buildPromptVersion,
  buildQuality,
  buildResolution,
  buildReviewDecision,
  buildScenario,
  buildSkill,
  buildSkillApproval,
  buildSkillMatch,
  buildSkillValidation,
  buildSkillVersion,
  buildSnapshot,
  buildUser,
  buildWarning,
} from './builders';

describe('test builders', () => {
  it('produce schema-valid entities with deterministic output', () => {
    expect(CaseSchema.parse(buildCase())).toEqual(buildCase());
    CaseSourceSchema.parse(buildCaseSource());
    CaseEventSchema.parse(buildCaseEvent());
    CaseParticipantSchema.parse(buildParticipant());
    CaseResolutionSchema.parse(buildResolution());
    EvidenceSchema.parse(buildEvidence());
    HypothesisSchema.parse(buildHypothesis());
    HypothesisEvidenceLinkSchema.parse(buildLink());
    ClaimSchema.parse(buildClaim());
    MissingEvidenceSchema.parse(buildMissingEvidence());
    DiagnosticActionSchema.parse(buildAction());
    DecisionForkSchema.parse(buildFork());
    QualityAssessmentSchema.parse(buildQuality());
    MetricEstimateSchema.parse(buildMetric());
    CaseWarningSchema.parse(buildWarning());
    CoachingReportSchema.parse(buildCoaching());
    AnalysisRunSchema.parse(buildAnalysisRun());
    DigitalTwinSchema.parse(buildDigitalTwin());
    SkillDnaSchema.parse(buildSkill());
    SkillVersionSchema.parse(buildSkillVersion());
    SkillMatchSchema.parse(buildSkillMatch());
    SkillValidationSchema.parse(buildSkillValidation());
    SkillApprovalSchema.parse(buildSkillApproval());
    JobSchema.parse(buildJob());
    ModelExecutionWithUsageSchema.parse(buildExecution());
    PromptVersionSchema.parse(buildPromptVersion());
    ReviewDecisionSchema.parse(buildReviewDecision());
    CounterfactualScenarioSchema.parse(buildScenario());
    UserSchema.parse(buildUser());
  });

  it('builds a consistent ingest request whose hashes match', () => {
    const input = buildIngestInput({ eventCount: 6, withResolution: true });
    CaseSchema.parse(input.case);
    CaseSourceSchema.parse(input.source);
    input.events.forEach((event) => CaseEventSchema.parse(event));
    input.participants.forEach((participant) => CaseParticipantSchema.parse(participant));
    CaseResolutionSchema.parse(input.resolution);
    expect(sha256Hex(input.storedPayload)).toBe(input.source.storedSha256);
    expect(input.case.eventCount).toBe(input.events.length);
    expect(input.events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(input.case.hasResolution).toBe(true);
  });

  it('gives each case id a reference of its own (they are unique per tenant), CG-1001 to the default case', () => {
    expect(buildCase().reference).toBe('CG-1001');
    expect(buildIngestInput().case.reference).toBe('CG-1001');
    const ids = ['case_a', 'case_b', 'case_c', 'case_a1', 'case_a2'];
    expect(new Set(ids.map((caseId) => buildIngestInput({ caseId }).case.reference)).size).toBe(
      ids.length,
    );
    expect(buildIngestInput({ caseId: 'case_a' }).case.reference).toBe('CG-case_a');
    expect(buildCase({ id: 'case_z' }).reference).toBe('CG-case_z');
    // Whatever the caller says wins.
    expect(buildIngestInput({ caseId: 'case_a', reference: 'CG-7' }).case.reference).toBe('CG-7');
    expect(buildCase({ id: 'case_z', reference: 'CG-9' }).reference).toBe('CG-9');
  });

  it('builds a full analysis snapshot that satisfies every schema and cross-reference', () => {
    const input = buildIngestInput();
    const snapshot = buildSnapshot(input);
    AnalysisRunSchema.parse(snapshot.run);
    DigitalTwinSchema.parse(snapshot.twin);
    snapshot.evidence.forEach((item) => EvidenceSchema.parse(item));
    snapshot.links.forEach((item) => HypothesisEvidenceLinkSchema.parse(item));
    snapshot.claims.forEach((item) => ClaimSchema.parse(item));
    snapshot.hypotheses.forEach((item) => HypothesisSchema.parse(item));
    snapshot.actions.forEach((item) => DiagnosticActionSchema.parse(item));
    snapshot.forks.forEach((item) => DecisionForkSchema.parse(item));
    QualityAssessmentSchema.parse(snapshot.quality);
    snapshot.metrics.forEach((item) => MetricEstimateSchema.parse(item));
    snapshot.warnings.forEach((item) => CaseWarningSchema.parse(item));
    CoachingReportSchema.parse(snapshot.coaching);
    snapshot.executions.forEach((item) => ModelExecutionWithUsageSchema.parse(item));
    const evidenceIds = new Set(snapshot.evidence.map((item) => item.id));
    expect(snapshot.links.every((link) => evidenceIds.has(link.evidenceId))).toBe(true);
    const eventIds = new Set(input.events.map((event) => event.id));
    expect(snapshot.evidence.every((item) => eventIds.has(item.eventId))).toBe(true);
  });

  it('exposes an audit hash recipe that is stable', () => {
    const base = {
      id: 'aud_1',
      tenantId: 'tenant_contoso_support',
      sequence: 1,
      occurredAt: '2026-01-15T09:00:00.000Z',
      actorId: 'user_ava_engineer',
      actorRole: 'engineer' as const,
      action: 'case.ingested',
      targetType: 'case',
      targetId: 'case_alpha',
      caseId: 'case_alpha',
      outcome: 'success' as const,
      details: { b: 2, a: 1 },
      correlationId: 'corr-1',
      prevHash: AUDIT_GENESIS_HASH,
    };
    const hash = computeAuditHash(AUDIT_GENESIS_HASH, base);
    AuditEventSchema.parse({ ...base, hash });
    expect(computeAuditHash(AUDIT_GENESIS_HASH, { ...base, details: { a: 1, b: 2 } })).toBe(hash);
  });
});
