import { z } from 'zod';

// ---------------------------------------------------------------- events & people

export const EVENT_TYPES = [
  'customer_email',
  'customer_call',
  'engineer_email',
  'case_note',
  'engineer_action',
  'diagnostic_result',
  'log_sample',
  'query_output',
  'escalation',
  'escalation_response',
  'status_change',
  'resolution_note',
  'validation_result',
  'system_event',
] as const;
export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;
export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  customer_email: 'Customer email',
  customer_call: 'Customer call',
  engineer_email: 'Engineer email',
  case_note: 'Case note',
  engineer_action: 'Engineer action',
  diagnostic_result: 'Diagnostic result',
  log_sample: 'Log sample',
  query_output: 'Query output',
  escalation: 'Escalation',
  escalation_response: 'Escalation response',
  status_change: 'Status change',
  resolution_note: 'Resolution note',
  validation_result: 'Validation result',
  system_event: 'System event',
};

export const ChannelSchema = z.enum(['email', 'phone', 'portal', 'internal', 'tool']);
export type Channel = z.infer<typeof ChannelSchema>;

export const PARTICIPANT_ROLES = [
  'customer_admin',
  'customer_end_user',
  'customer_network_admin',
  'support_engineer',
  'escalation_engineer',
  'support_manager',
  'system',
] as const;
export const ParticipantRoleSchema = z.enum(PARTICIPANT_ROLES);
export type ParticipantRole = z.infer<typeof ParticipantRoleSchema>;
export const PARTICIPANT_ROLE_LABELS: Record<ParticipantRole, string> = {
  customer_admin: 'Customer admin',
  customer_end_user: 'Customer end user',
  customer_network_admin: 'Customer network admin',
  support_engineer: 'Support engineer',
  escalation_engineer: 'Escalation engineer',
  support_manager: 'Support manager',
  system: 'System',
};
/** Roles whose statements are customer-side (used by classification and customer-effort logic). */
export const CUSTOMER_SIDE_ROLES: readonly ParticipantRole[] = [
  'customer_admin',
  'customer_end_user',
  'customer_network_admin',
];
export const ENGINEER_SIDE_ROLES: readonly ParticipantRole[] = [
  'support_engineer',
  'escalation_engineer',
  'support_manager',
];

export const CaseStatusSchema = z.enum(['open', 'resolved', 'closed']);
export type CaseStatus = z.infer<typeof CaseStatusSchema>;
export const SeveritySchema = z.enum(['A', 'B', 'C']);
export type Severity = z.infer<typeof SeveritySchema>;

// ---------------------------------------------------------------- effort / risk / strength

export const EFFORT_LEVELS = ['none', 'low', 'medium', 'high', 'very_high'] as const;
export const EffortLevelSchema = z.enum(EFFORT_LEVELS);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;
/** Default numeric scale in [0,1]; the live scale comes from the versioned action-value config. */
export const DEFAULT_EFFORT_SCALE: Record<EffortLevel, number> = {
  none: 0,
  low: 0.2,
  medium: 0.5,
  high: 0.8,
  very_high: 1,
};
/** Estimated customer-side minutes per effort level (assumption A-06; configurable). */
export const DEFAULT_EFFORT_MINUTES: Record<EffortLevel, number> = {
  none: 0,
  low: 10,
  medium: 30,
  high: 90,
  very_high: 180,
};

export const RiskLevelSchema = z.enum(['low', 'medium', 'high']);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;
export const StrengthSchema = z.enum(['strong', 'moderate', 'weak']);
export type Strength = z.infer<typeof StrengthSchema>;
export const LevelSchema = z.enum(['low', 'medium', 'high']);
export type Level = z.infer<typeof LevelSchema>;

// ---------------------------------------------------------------- evidence ledger

export const EVIDENCE_CATEGORIES = [
  'confirmed_fact',
  'customer_reported',
  'engineer_assumption',
  'diagnostic_evidence',
  'ai_inference',
  'conflicting_evidence',
  'missing_evidence',
  'simulated_outcome',
] as const;
export const EvidenceCategorySchema = z.enum(EVIDENCE_CATEGORIES);
export type EvidenceCategory = z.infer<typeof EvidenceCategorySchema>;
export const EVIDENCE_CATEGORY_LABELS: Record<EvidenceCategory, string> = {
  confirmed_fact: 'Confirmed fact',
  customer_reported: 'Customer-reported observation',
  engineer_assumption: 'Engineer assumption',
  diagnostic_evidence: 'Diagnostic evidence',
  ai_inference: 'AI inference',
  conflicting_evidence: 'Conflicting evidence',
  missing_evidence: 'Missing evidence',
  simulated_outcome: 'Simulated outcome',
};

export const CLAIM_FLAGS = [
  'unsupported_root_cause',
  'assumption_as_fact',
  'ignored_contradiction',
  'template_without_evidence',
  'contradicted',
  'unvalidated_closure',
] as const;
export const ClaimFlagSchema = z.enum(CLAIM_FLAGS);
export type ClaimFlag = z.infer<typeof ClaimFlagSchema>;

export const HYPOTHESIS_STATUSES = [
  'active',
  'leading',
  'demoted',
  'ruled_out',
  'confirmed',
] as const;
export const HypothesisStatusSchema = z.enum(HYPOTHESIS_STATUSES);
export type HypothesisStatus = z.infer<typeof HypothesisStatusSchema>;

export const HYPOTHESIS_CATEGORIES = [
  'identity',
  'network',
  'client',
  'service',
  'configuration',
  'unknown',
] as const;
export const HypothesisCategorySchema = z.enum(HYPOTHESIS_CATEGORIES);
export type HypothesisCategory = z.infer<typeof HypothesisCategorySchema>;

// ---------------------------------------------------------------- actions & forks

export const ACTION_KINDS = [
  'log_query',
  'customer_request',
  'client_diagnostic',
  'network_diagnostic',
  'configuration_change',
  'remediation',
  'escalation',
  'communication',
  'validation',
  'analysis',
] as const;
export const ActionKindSchema = z.enum(ACTION_KINDS);
export type ActionKind = z.infer<typeof ActionKindSchema>;
export const ACTION_KIND_LABELS: Record<ActionKind, string> = {
  log_query: 'Log query',
  customer_request: 'Customer request',
  client_diagnostic: 'Client diagnostic',
  network_diagnostic: 'Network diagnostic',
  configuration_change: 'Configuration change',
  remediation: 'Remediation',
  escalation: 'Escalation',
  communication: 'Communication',
  validation: 'Validation',
  analysis: 'Analysis',
};

export const FORK_CATEGORIES = [
  'alternative_action_available',
  'assumption_as_fact',
  'contradiction_ignored',
  'low_value_action',
  'premature_destructive_action',
  'premature_escalation',
  'disproportionate_customer_effort',
  'high_value_signal_unused',
] as const;
export const ForkCategorySchema = z.enum(FORK_CATEGORIES);
export type ForkCategory = z.infer<typeof ForkCategorySchema>;
export const FORK_CATEGORY_LABELS: Record<ForkCategory, string> = {
  alternative_action_available: 'Better action was available',
  assumption_as_fact: 'Assumption treated as fact',
  contradiction_ignored: 'Contradictory evidence ignored',
  low_value_action: 'Low-value action selected',
  premature_destructive_action: 'Destructive action selected prematurely',
  premature_escalation: 'Escalation before minimum evidence',
  disproportionate_customer_effort: 'Customer effort without proportional value',
  high_value_signal_unused: 'High-value signal available but unused',
};

// ---------------------------------------------------------------- quality

export const QUALITY_DIMENSIONS = [
  'evidence_integrity',
  'diagnostic_reasoning',
  'scoping_completeness',
  'customer_communication',
  'resolution_validation',
  'efficiency_proportionality',
] as const;
export const QualityDimensionKeySchema = z.enum(QUALITY_DIMENSIONS);
export type QualityDimensionKey = z.infer<typeof QualityDimensionKeySchema>;
export const QUALITY_DIMENSION_LABELS: Record<QualityDimensionKey, string> = {
  evidence_integrity: 'Evidence integrity',
  diagnostic_reasoning: 'Diagnostic reasoning',
  scoping_completeness: 'Scoping completeness',
  customer_communication: 'Customer communication',
  resolution_validation: 'Resolution validation',
  efficiency_proportionality: 'Efficiency and proportionality',
};
export const DEFAULT_QUALITY_WEIGHTS: Record<QualityDimensionKey, number> = {
  evidence_integrity: 0.25,
  diagnostic_reasoning: 0.2,
  scoping_completeness: 0.15,
  customer_communication: 0.15,
  resolution_validation: 0.15,
  efficiency_proportionality: 0.1,
};

export const PENALTY_KEYS = [
  'unsupported_root_cause',
  'template_completion_without_evidence',
  'repeated_low_value_diagnostic',
  'destructive_action_without_justification',
  'ignored_contradiction',
  'premature_escalation',
  'premature_closure',
  'unnecessary_customer_request',
  'missing_resolution_validation',
  'workaround_fix_conflation',
] as const;
export const PenaltyKeySchema = z.enum(PENALTY_KEYS);
export type PenaltyKey = z.infer<typeof PenaltyKeySchema>;
export const PENALTY_LABELS: Record<PenaltyKey, string> = {
  unsupported_root_cause: 'Unsupported root-cause claim',
  template_completion_without_evidence: 'Template completion without evidence',
  repeated_low_value_diagnostic: 'Repeated low-value diagnostic',
  destructive_action_without_justification: 'Destructive action without justification',
  ignored_contradiction: 'Ignored contradiction',
  premature_escalation: 'Premature escalation',
  premature_closure: 'Premature closure',
  unnecessary_customer_request: 'Unnecessary customer request',
  missing_resolution_validation: 'Missing resolution validation',
  workaround_fix_conflation: 'Workaround and permanent fix not separated',
};
export const DEFAULT_PENALTY_POINTS: Record<PenaltyKey, number> = {
  unsupported_root_cause: 8,
  template_completion_without_evidence: 4,
  repeated_low_value_diagnostic: 3,
  destructive_action_without_justification: 7,
  ignored_contradiction: 6,
  premature_escalation: 5,
  premature_closure: 8,
  unnecessary_customer_request: 3,
  missing_resolution_validation: 8,
  workaround_fix_conflation: 4,
};

export const WARNING_CATEGORIES = [
  'scoping',
  'evidence',
  'troubleshooting',
  'communication',
  'closure',
] as const;
export const WarningCategorySchema = z.enum(WARNING_CATEGORIES);
export type WarningCategory = z.infer<typeof WarningCategorySchema>;
export const WARNING_CATEGORY_LABELS: Record<WarningCategory, string> = {
  scoping: 'Scoping quality',
  evidence: 'Evidence quality',
  troubleshooting: 'Troubleshooting quality',
  communication: 'Communication quality',
  closure: 'Closure quality',
};
export const PrioritySchema = z.enum(['critical', 'high', 'medium', 'low']);
export type Priority = z.infer<typeof PrioritySchema>;

// ---------------------------------------------------------------- skills

export const SKILL_LIFECYCLE = [
  'discovered',
  'draft',
  'simulation_tested',
  'expert_reviewed',
  'pilot',
  'validated',
  'published',
  'deprecated',
  'retired',
] as const;
export const SkillLifecycleSchema = z.enum(SKILL_LIFECYCLE);
export type SkillLifecycle = z.infer<typeof SkillLifecycleSchema>;
export const SKILL_LIFECYCLE_LABELS: Record<SkillLifecycle, string> = {
  discovered: 'Discovered',
  draft: 'Draft',
  simulation_tested: 'Simulation Tested',
  expert_reviewed: 'Expert Reviewed',
  pilot: 'Pilot',
  validated: 'Validated',
  published: 'Published',
  deprecated: 'Deprecated',
  retired: 'Retired',
};

// ---------------------------------------------------------------- AI orchestration

export const AGENT_NAMES = [
  'timeline_analyzer',
  'evidence_classifier',
  'hypothesis_generator',
  'decision_fork_detector',
  'counterfactual_simulator',
  'quality_judge',
  'skilldna_extractor',
  'communication_coach',
  'token_governor',
  'safety_policy_validator',
] as const;
export const AgentNameSchema = z.enum(AGENT_NAMES);
export type AgentName = z.infer<typeof AgentNameSchema>;
export const AGENT_LABELS: Record<AgentName, string> = {
  timeline_analyzer: 'Timeline Analyzer',
  evidence_classifier: 'Evidence Classifier',
  hypothesis_generator: 'Hypothesis Generator',
  decision_fork_detector: 'Decision-Fork Detector',
  counterfactual_simulator: 'Counterfactual Simulator',
  quality_judge: 'Quality Judge',
  skilldna_extractor: 'SkillDNA Extractor',
  communication_coach: 'Communication Coach',
  token_governor: 'Token Governor',
  safety_policy_validator: 'Safety and Policy Validator',
};

export const ProviderKindSchema = z.enum(['deterministic', 'azure-openai']);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export const JobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatusSchema>;
