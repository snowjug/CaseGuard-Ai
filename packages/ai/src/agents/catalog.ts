import type { AgentName } from '@caseguard/schemas';
import type { TemporalMode } from '../context/types';

export type AgentDifficulty = 'deterministic' | 'classification' | 'reasoning' | 'generation';
export type KnowledgeSection = 'hypotheses' | 'actions' | 'requirements' | 'signals';

export interface AgentMeta {
  name: AgentName;
  label: string;
  /** Pre-resolution agents never see the final resolution; post-hoc agents may (labelled hindsight). */
  temporalMode: TemporalMode;
  /** Drives model routing: cheap model for classification, stronger for reasoning, code for math. */
  difficulty: AgentDifficulty;
  /** Deterministic-only agents are pure code and never call a model. */
  execution: 'model_or_deterministic' | 'deterministic_only';
  sections: {
    evidence: boolean;
    claims: 'none' | 'plain' | 'flagged';
    knowledge: readonly KnowledgeSection[];
  };
  /**
   * Items of this output array are anchored to a moment in the case: everything they cite must
   * have been known then (strictly before the anchor event, or up to the claim's own event).
   */
  itemAnchor: { arrayKey: string; source: 'claim' | 'event'; inclusive: boolean } | null;
}

export const AGENT_CATALOG: Readonly<Record<AgentName, AgentMeta>> = {
  timeline_analyzer: {
    name: 'timeline_analyzer',
    label: 'Timeline Analyzer',
    temporalMode: 'pre_resolution',
    difficulty: 'classification',
    execution: 'model_or_deterministic',
    sections: { evidence: false, claims: 'none', knowledge: [] },
    itemAnchor: null,
  },
  evidence_classifier: {
    name: 'evidence_classifier',
    label: 'Evidence Classifier',
    temporalMode: 'pre_resolution',
    difficulty: 'classification',
    execution: 'model_or_deterministic',
    sections: { evidence: true, claims: 'plain', knowledge: [] },
    itemAnchor: { arrayKey: 'classifications', source: 'claim', inclusive: true },
  },
  hypothesis_generator: {
    name: 'hypothesis_generator',
    label: 'Hypothesis Generator',
    temporalMode: 'pre_resolution',
    difficulty: 'reasoning',
    execution: 'model_or_deterministic',
    sections: {
      evidence: true,
      claims: 'none',
      knowledge: ['hypotheses', 'actions', 'requirements'],
    },
    itemAnchor: null,
  },
  decision_fork_detector: {
    name: 'decision_fork_detector',
    label: 'Decision-Fork Detector',
    temporalMode: 'pre_resolution',
    difficulty: 'classification',
    execution: 'model_or_deterministic',
    sections: { evidence: true, claims: 'none', knowledge: ['actions'] },
    itemAnchor: { arrayKey: 'forks', source: 'event', inclusive: false },
  },
  counterfactual_simulator: {
    name: 'counterfactual_simulator',
    label: 'Counterfactual Simulator',
    temporalMode: 'pre_resolution',
    difficulty: 'reasoning',
    execution: 'model_or_deterministic',
    sections: { evidence: true, claims: 'none', knowledge: [] },
    itemAnchor: null,
  },
  quality_judge: {
    name: 'quality_judge',
    label: 'Quality Judge',
    temporalMode: 'post_hoc',
    difficulty: 'reasoning',
    execution: 'model_or_deterministic',
    sections: {
      evidence: true,
      claims: 'flagged',
      knowledge: ['hypotheses', 'actions', 'requirements'],
    },
    itemAnchor: null,
  },
  skilldna_extractor: {
    name: 'skilldna_extractor',
    label: 'SkillDNA Extractor',
    temporalMode: 'post_hoc',
    difficulty: 'generation',
    execution: 'model_or_deterministic',
    sections: {
      evidence: true,
      claims: 'none',
      knowledge: ['hypotheses', 'actions', 'requirements', 'signals'],
    },
    itemAnchor: null,
  },
  communication_coach: {
    name: 'communication_coach',
    label: 'Communication Coach',
    temporalMode: 'post_hoc',
    difficulty: 'generation',
    execution: 'model_or_deterministic',
    sections: {
      evidence: true,
      claims: 'flagged',
      knowledge: ['hypotheses', 'actions', 'requirements'],
    },
    itemAnchor: null,
  },
  token_governor: {
    name: 'token_governor',
    label: 'Token Governor',
    temporalMode: 'post_hoc',
    difficulty: 'deterministic',
    execution: 'deterministic_only',
    sections: { evidence: false, claims: 'none', knowledge: [] },
    itemAnchor: null,
  },
  safety_policy_validator: {
    name: 'safety_policy_validator',
    label: 'Safety and Policy Validator',
    temporalMode: 'post_hoc',
    difficulty: 'deterministic',
    execution: 'deterministic_only',
    sections: { evidence: false, claims: 'none', knowledge: [] },
    itemAnchor: null,
  },
};
