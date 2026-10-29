/**
 * Ids of the built-in knowledge-pack requirements that carry closure semantics. A pack that does not
 * define one of them simply makes the related check indeterminate (it widens the range, it never
 * invents a result).
 */
export const CLOSURE_REQUIREMENT_IDS = {
  fixValidation: 'req.fix-validation',
  customerConfirmation: 'req.customer-confirmation',
  workaroundVsFix: 'req.workaround-vs-fix',
} as const;

/**
 * Thresholds that turn observable facts into 0-1 sub-check scores. They are deliberately plain,
 * documented numbers (assumption: support-process norms, not measured data) and can be overridden
 * per call so a tenant policy or a test can change them without touching the rules.
 */
export interface QualityRuleParameters {
  /** Half-width (score points) added around every dimension score for rule-detection uncertainty. */
  uncertaintyMargin: number;
  /** First response within this many minutes scores 1; at `firstResponseBadMinutes` it scores 0. */
  firstResponseGoodMinutes: number;
  firstResponseBadMinutes: number;
  /** Reply to a customer message that awaits an answer: good and bad waits in hours. */
  replyWaitGoodHours: number;
  replyWaitBadHours: number;
  /** Number of "please update us" chasers from the customer at which the check scores 0. */
  chaseCountForZero: number;
  /** Customer minutes requested (effort-level minutes) that score 1 and 0. */
  customerMinutesGood: number;
  customerMinutesBad: number;
  /** Hours between the right hypothesis leading and a confirmed diagnosis that score 1 and 0. */
  diagnosisLagGoodHours: number;
  diagnosisLagBadHours: number;
  /** Score slope per flagged assertion / contradiction in the evidence-integrity checks. */
  unsupportedClaimSlope: number;
  contradictionSlope: number;
  /** Score lost when every risky step was taken without justification (scaled by the share). */
  unjustifiedRiskSlope: number;
  /** Customer effort score (0-1) at or above which a request counts as heavy. */
  heavyEffortScore: number;
  /** Requirements younger than this many minutes are not yet held against the scoping score. */
  scopingGraceMinutes: number;
  /** Share of a recommended improvement's gain assumed to materialise (estimate, not a promise). */
  improvementRealization: number;
  /** Improvements worth less than this many composite points are not listed. */
  minImprovementGain: number;
}

export const DEFAULT_QUALITY_RULE_PARAMETERS: QualityRuleParameters = {
  uncertaintyMargin: 4,
  firstResponseGoodMinutes: 60,
  firstResponseBadMinutes: 480,
  replyWaitGoodHours: 4,
  replyWaitBadHours: 24,
  chaseCountForZero: 4,
  customerMinutesGood: 120,
  customerMinutesBad: 600,
  diagnosisLagGoodHours: 4,
  diagnosisLagBadHours: 72,
  unsupportedClaimSlope: 0.15,
  contradictionSlope: 0.1,
  unjustifiedRiskSlope: 0.6,
  heavyEffortScore: 0.8,
  scopingGraceMinutes: 60,
  improvementRealization: 0.8,
  minImprovementGain: 1,
};
