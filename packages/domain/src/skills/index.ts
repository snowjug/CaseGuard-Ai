// SkillDNA: extraction, lifecycle governance, versioning and mutation, matching and guidance,
// conformance, simulation tests, estimated impact and effectiveness. Pure and deterministic: the
// clock, ids and seeds are injected and no function performs I/O.

export {
  SKILL_ERROR_HTTP,
  applySkillChangeSet,
  createSkillIdGenerator,
  currentVersionOf,
  skillFail,
  skillOk,
  type SkillActor,
  type SkillAggregate,
  type SkillAuditPayload,
  type SkillChangeSet,
  type SkillError,
  type SkillErrorCode,
  type SkillOpContext,
  type SkillResult,
} from './types';

export {
  extractSkillCandidates,
  type ExtractionRefusal,
  type SkillDraft,
  type SkillExtractionInput,
  type SkillExtractionResult,
} from './extraction';
export { deriveSeedSkills, type SeedCase, type SeedSkills, type SeedSkillsInput } from './seeds';

export {
  SKILL_TRANSITIONS,
  describeSkillTransitions,
  isFullScopeValidation,
  latestValidation,
  pilotApproversOf,
  requiredValidationsFor,
  transitionRule,
  transitionSkill,
  validationShortfall,
  validationStatusFor,
  type TransitionRequest,
} from './lifecycle';
export {
  decideSkillVersion,
  rollbackSkill,
  type RollbackRequest,
  type VersionDecisionRequest,
} from './versions';
export { advanceSkillGovernance, type GovernanceCast } from './flow';
export { buildSkillDetail } from './detail';

export { diffSkillVersions } from './diff';
export {
  proposeMutations,
  type MutationItem,
  type MutationKind,
  type MutationOutcome,
  type MutationProposal,
  type MutationSourceCase,
  type ProposeMutationsInput,
} from './mutation';

export {
  APPLIES_THRESHOLD,
  MATCHABLE_LIFECYCLES,
  PARTIAL_THRESHOLD,
  matchSkills,
  type ExcludedSkill,
  type MatchSkillsInput,
  type MatchableSkill,
  type SkillMatchSet,
} from './matching';
export { isSafeConditionPattern, type CaseInfo } from './evidence';
export {
  STALE_AFTER_DAYS,
  SAME_SITUATION_SIMILARITY,
  assessSkillQuality,
  assessSkillUse,
  type LibrarySkill,
  type SkillQualityInput,
  type SkillUseInput,
} from './quality';
export {
  skillApplicabilityFor,
  withSkillApplicability,
  type PathForSkills,
} from './scenario-applicability';
export { asOfView, buildGuidedPlan, type AnalysisAsOf, type GuidedPlanInput } from './guidance';
export {
  toMatchSteps,
  type GuidedPlan,
  type GuidedPlanStep,
  type PlanExpectedOutcome,
  type PlanStatus as SkillPlanStatus,
  type PlanTemplate,
} from './plan';
export {
  CONFORMANCE_HIGH,
  CONFORMANCE_MODERATE,
  checkConformance,
  toMatchConformance,
  type ConformanceInput,
  type ConformanceReport as SkillConformanceReport,
  type ConformanceStage as SkillConformanceStage,
  type ConformanceStatus as SkillConformanceStatus,
} from './conformance';

export {
  evaluateReplayCase,
  runSkillRegressionSuite,
  runSkillSimulationTest,
  toSkillValidation,
  type ReplayCaseInput,
  type ReplayExpectation,
  type ReplayVerdict,
  type SkillCaseReport,
  type SkillCheck,
  type SkillReplayCase,
  type SkillSimulationReport,
} from './simulation';
export {
  replaySkillPath,
  simulateBaselinePolicy,
  type BaselineResult,
  type ReplayStep as SkillReplayStep,
  type SkillReplayResult,
} from './replay';
export {
  estimateSkillImpact,
  impactPrecedentOf,
  type ImpactDecisionPoint,
  type ImpactPrecedent as SkillImpactPrecedent,
  type SkillImpactEstimate,
  type SkillImpactInput,
} from './impact';
export {
  aggregateSkillEffectiveness,
  type SkillEffectivenessReport,
  type SkillUsagePrecedent,
  type SkillUsageRecord,
} from './effectiveness';
export {
  buildSkillOverlay,
  chooseDecisionPoint,
  firstRecommendedStep,
  subtractSaving,
  type RecordedPathInput,
  type SkillOverlayInput,
} from './overlay';
