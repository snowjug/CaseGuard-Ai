import type {
  ActionValueConfig,
  AgentName,
  CaseEvent,
  CaseResolution,
  CounterfactualScenario,
  CounterfactualStrategy,
  DecisionFork,
  ProviderKind,
} from '@caseguard/schemas';
import type {
  CompiledPack,
  DeterministicAnalysis,
  EngineContext,
  TemporalView,
} from '@caseguard/domain';
import type { ReviewConclusion } from '../reasoning/types';
import type { ValidationContext } from '../validators/types';

/** Material used only to detect leakage in outputs; it is never rendered into a prompt. */
export interface Hindsight {
  events: readonly CaseEvent[];
  resolution: CaseResolution | null;
}

export interface TaskBase {
  tenantId: string;
  caseId: string | null;
  analysisRunId: string | null;
  /** The only window of the case the model may see. */
  view: TemporalView;
  pack: CompiledPack;
  config: ActionValueConfig;
  ctx: EngineContext;
  /** Deterministic analysis; every artefact is restricted to `view` before it is used. */
  analysis: DeterministicAnalysis;
  hindsight?: Hindsight | undefined;
}

export type TimelineTaskInput = TaskBase;
export type EvidenceTaskInput = TaskBase & { claimIds?: readonly string[] | undefined };
export type HypothesisTaskInput = TaskBase;
export type ForkTaskInput = TaskBase;
export type QualityTaskInput = TaskBase;
export type CoachTaskInput = TaskBase;

export type CounterfactualTaskInput = TaskBase & {
  fork: DecisionFork;
  strategy: CounterfactualStrategy;
  /** Full event log: used by the deterministic domain call and the leak guard only. */
  events: readonly CaseEvent[];
  resolution: CaseResolution | null;
  rolloutCount?: number | undefined;
};

export type SkillTaskInput = TaskBase & {
  fork: DecisionFork;
  scenario: CounterfactualScenario;
};

export interface GovernorTaskInput {
  tenantId: string;
  caseId: string | null;
  targetAgent: AgentName;
  estimatedInputTokens: number;
  providerKind: ProviderKind;
}

export interface SafetyTaskInput {
  tenantId: string;
  caseId: string | null;
  candidateAgent: AgentName;
  candidateOutput: unknown;
  validation: ValidationContext;
}

/** The reasoner reads the redacted events and the vocabulary. It is not given the engine's findings. */
export type CaseReasonerTaskInput = TaskBase;

/** The critic reads the same events and a numbered list of conclusions under review (and may critique only those). */
export type CaseCriticTaskInput = TaskBase & { conclusions: readonly ReviewConclusion[] };

export interface TaskInputs {
  timeline_analyzer: TimelineTaskInput;
  evidence_classifier: EvidenceTaskInput;
  hypothesis_generator: HypothesisTaskInput;
  decision_fork_detector: ForkTaskInput;
  counterfactual_simulator: CounterfactualTaskInput;
  quality_judge: QualityTaskInput;
  skilldna_extractor: SkillTaskInput;
  communication_coach: CoachTaskInput;
  token_governor: GovernorTaskInput;
  safety_policy_validator: SafetyTaskInput;
  case_reasoner: CaseReasonerTaskInput;
  case_critic: CaseCriticTaskInput;
}

export type AgentTaskOf<A extends AgentName> = { agent: A; input: TaskInputs[A] };

/** Discriminated union of every task the orchestrator can run. */
export type AgentTask = { [A in AgentName]: AgentTaskOf<A> }[AgentName];
