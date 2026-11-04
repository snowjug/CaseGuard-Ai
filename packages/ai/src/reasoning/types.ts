import type {
  AiFindingCheck,
  AiFindingEvidence,
  ConfidenceBasis,
  CriticResult,
  Critique,
  FindingType,
  Level,
  ProposedCitation,
  ReasonerProposal,
} from '@caseguard/schemas';

/**
 * The stable codes of the grounding rules. A proposal that fails any of them is dropped and counted under every code it
 * failed; the rest of the reply survives. The codes never carry model text.
 */
export const PROPOSAL_CODES = [
  'schema',
  'prohibited_field',
  'unknown_event',
  'unknown_vocabulary_id',
  'excerpt_not_found',
  'excerpt_wrong_event',
  'missing_evidence',
  'future_information',
  'unsupported_certainty',
  'numeric_time_claim',
  'model_basis_overclaim',
  'instruction_like_text',
  'secret_like_text',
  'duplicate',
  'excessive_output',
  'critic_unknown_target',
  'critic_new_story',
  'policy_violation',
] as const;
export type ProposalCode = (typeof PROPOSAL_CODES)[number];

/** What each code means, in words a reviewer can read (used by the planted-error report and the README). */
export const PROPOSAL_CODE_DESCRIPTIONS: Record<ProposalCode, string> = {
  schema:
    'Does not match the proposal schema (wrong type, missing key, unknown key, value not allowed).',
  prohibited_field:
    'Names a field only the server may set (approved, accepted, status, hybrid status, ...).',
  unknown_event: 'Cites an event the model was not shown.',
  unknown_vocabulary_id:
    'Names a signal, action, requirement or skill that is not in the allow-list.',
  excerpt_not_found: 'Quotes text that is not in the cited event as the model saw it.',
  excerpt_wrong_event: 'Quotes text that is in another event, not in the cited one.',
  missing_evidence: 'Carries no citation.',
  future_information: 'Cites or uses something from after the moment the finding is about.',
  unsupported_certainty:
    'Claims high confidence or absolute certainty on an inferred or general basis.',
  numeric_time_claim: 'States a saved, reduced or shortened time as a number.',
  model_basis_overclaim:
    'Claims a measured or engine-estimated basis, which only the engine may use.',
  instruction_like_text:
    'Contains instruction-like text, markup, a link or signs of obeying the record.',
  secret_like_text: 'Contains a secret-like value.',
  duplicate: 'Repeats another proposal of the same reply.',
  excessive_output: 'The reply, a list or a text is longer than the allowed size.',
  critic_unknown_target: 'A critique targets a conclusion that was not under review.',
  critic_new_story:
    'A critique has no target, no citation, or names an alternative that is not a pack hypothesis.',
  policy_violation:
    'Recommends something the safety policy forbids (destructive, approval-required, weakening security, closing the case) or judges individuals.',
};

export interface ProposalIssue {
  code: ProposalCode;
  /** Where in the reply, with model-chosen key names removed. */
  path: string;
  /** Our own wording; never model text. */
  message: string;
}

export type ProposalAgent = 'case_reasoner' | 'case_critic';

/** A proposal that passed every rule, with the quotations the server located itself. */
export interface KeptProposal<T extends ReasonerProposal = ReasonerProposal> {
  proposal: T;
  /** One located quotation per `proposal.evidence` entry, in the same order. */
  evidence: AiFindingEvidence[];
  /** For a synthesis: the located quotations of each key point, in the same order. Empty otherwise. */
  keyPointEvidence: AiFindingEvidence[][];
  checks: AiFindingCheck[];
  /** Why validation passed with notes (for example a quotation verified in the redacted view only). */
  notes: string[];
}

export interface KeptCritique {
  critique: Critique;
  evidence: AiFindingEvidence[];
}

export interface KeptCritic {
  result: CriticResult;
  evidence: AiFindingEvidence[];
  critiques: KeptCritique[];
}

export interface DroppedItem {
  /** The type of the dropped proposal, or `reply` when the whole reply was unusable. */
  type: FindingType | 'reply';
  path: string;
  codes: ProposalCode[];
}

/**
 * What validation of one reply found. `proposed` counts proposals (reasoner) or critiques (critic) before any was
 * dropped; `rejectedByCode` counts proposals per code (a proposal that failed two rules counts under both, so the
 * numbers do not add up to `proposed - kept`).
 */
export interface ProposalReport {
  agent: ProposalAgent;
  proposed: number;
  kept: number;
  dropped: DroppedItem[];
  rejectedByCode: Partial<Record<ProposalCode, number>>;
  /** Not empty when the reply as a whole was unusable (not JSON, too large, wrong top-level shape). */
  wholeReply: ProposalIssue[];
  reasoner: KeptProposal[] | null;
  critic: KeptCritic | null;
}

/** One conclusion under review by the critic, with the id the critic must use. */
export interface ReviewConclusion {
  /** `C1`, `C2`, ... assigned by the server for this critic call. */
  id: string;
  source: 'engine' | 'model';
  kind: 'leading_hypothesis' | 'fork' | 'recommendation' | 'counterfactual' | FindingType;
  text: string;
  reasoning: string | null;
  confidenceBasis: ConfidenceBasis | null;
  confidence: Level | null;
  eventIds: string[];
  evidence: ProposedCitation[];
  /** The engine item or the reasoner's proposal this stands for. Never shown to the critic. */
  ref: string;
}

/** The text of an event as stored (before any redaction done for the model). */
export interface StoredEvent {
  id: string;
  title: string | null;
  body: string;
}

/** Where the text of a proposal is, for the rules that read it. */
export interface TextAt {
  path: string;
  text: string;
}
