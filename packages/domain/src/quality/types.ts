import type {
  ActionValueConfig,
  EvidenceLink,
  PenaltyKey,
  QualityAssessment,
  QualityConfig,
  QualityDimensionKey,
  SubCheck,
} from '@caseguard/schemas';
import type { EngineContext } from '../engine/context';
import type { DeterministicAnalysis } from '../engine/pipeline';
import type { CompiledPack } from '../knowledge/compile';
import type { QualityRuleParameters } from './parameters';

/** The six dimension results before penalties are applied. */
export interface DimensionDraft {
  key: QualityDimensionKey;
  label: string;
  /** False when no sub-check could be decided: the dimension is left out of the composite. */
  assessable: boolean;
  subChecks: SubCheck[];
  rawScore: number;
  low: number;
  high: number;
  rationale: string;
}

/** One detected penalty before points and caps are applied. */
export interface PenaltyDraft {
  key: PenaltyKey;
  dimension: QualityDimensionKey;
  evidence: EvidenceLink[];
  rationale: string;
  /** How many separate occurrences the rule found (the penalty itself is applied once). */
  instances: number;
  /** Decision forks that illustrate the penalty (links improvements to forks). */
  forkIds: string[];
}

export interface QualityInput {
  /** Analysis of the view to score: the full case, or a prefix for an as-of review. */
  analysis: DeterministicAnalysis;
  pack: CompiledPack;
  ctx: EngineContext;
  /** Defaults to DEFAULT_QUALITY_CONFIG. */
  config?: QualityConfig;
  /** Used for the customer-effort scale and the risk ceiling; defaults to DEFAULT_ACTION_VALUE_CONFIG. */
  actionConfig?: ActionValueConfig;
  parameters?: Partial<QualityRuleParameters>;
  /**
   * Boundary label stored on the review. When omitted it is derived: null for the whole case, the
   * view boundary when later events were withheld.
   */
  asOf?: string | null;
}

/** The Case Quality Index review. It is always an estimate that supports a human review. */
export type QualityReview = QualityAssessment;
