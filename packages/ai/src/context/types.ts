import type {
  AgentName,
  ClaimFlag,
  EventType,
  ParticipantRole,
  Strength,
} from '@caseguard/schemas';
import type { InjectionIndicator } from '../types';

export type TemporalMode = 'pre_resolution' | 'post_hoc';

/** 0 = full context ... 4 = minimal. Higher levels trade detail for tokens (spec 5.14). */
export type TrimLevel = 0 | 1 | 2 | 3 | 4;
export const MAX_TRIM_LEVEL: TrimLevel = 4;

export interface ContextEvent {
  id: string;
  at: string;
  type: EventType;
  role: ParticipantRole;
  title: string | null;
  /** Redacted, clipped body; null at the highest trim levels (header only). */
  text: string | null;
  gapMinutes: number | null;
  /** Label of the engineering action recognised by the deterministic engine, if any. */
  action: string | null;
  flags: string[];
  /** Set when the body duplicates an earlier event; the body is then omitted. */
  duplicateOf: string | null;
}

export interface ContextEvidence {
  id: string;
  eventId: string;
  at: string;
  label: string;
  summary: string;
  kind: 'presence' | 'absence';
  strength: Strength;
  excerpt: string | null;
}

export interface ContextClaim {
  id: string;
  eventId: string | null;
  at: string;
  role: ParticipantRole | null;
  text: string;
  flags: ClaimFlag[];
}

export interface ContextKnowledge {
  packId: string;
  packVersion: string;
  /** With a vocabulary the descriptions are the point; otherwise only the first 240 characters of each hypothesis. */
  hypotheses: { id: string; name: string; description: string }[];
  /**
   * An entry of the ranking catalogue carries the attributes the ranking uses; an entry of a vocabulary carries its
   * description instead (and nothing else but the id and the label).
   */
  actions: {
    id: string;
    label: string;
    description?: string;
    kind?: string;
    executor?: string;
    valueClass?: string;
    customerEffort?: string;
    operationalRisk?: number;
    destructive?: boolean;
    requiresApproval?: boolean;
  }[];
  requirements: { id: string; label: string; description?: string; criticality?: string }[];
  signals: { id: string; label: string; description?: string }[];
}

export interface AgentContext {
  schemaVersion: 1;
  agent: AgentName;
  boundary: {
    asOf: string;
    mode: 'at' | 'before';
    temporalMode: TemporalMode;
    resolutionIncluded: boolean;
  };
  workload: string;
  events: ContextEvent[];
  evidence: ContextEvidence[];
  claims: ContextClaim[];
  knowledge: ContextKnowledge | null;
  /** Agent-specific, JSON-serialisable material (fork, allowed actions, scenario, findings...). */
  focus: Record<string, unknown>;
  trimming: { level: TrimLevel; eventsOmitted: number; duplicatesRemoved: number };
}

export interface EventStamp {
  at: string;
  sequence: number;
}

/** Everything a model may legitimately cite: the ids that were actually supplied in the prompt. */
export interface ContextIndex {
  events: ReadonlyMap<string, EventStamp>;
  /** Valid anchors outside the visible view, e.g. the decision event of a counterfactual task. */
  anchors: ReadonlyMap<string, EventStamp>;
  evidence: ReadonlyMap<string, { at: string; eventId: string }>;
  claims: ReadonlyMap<string, { at: string; eventId: string | null }>;
  hypotheses: ReadonlySet<string>;
  actions: ReadonlySet<string>;
  requirements: ReadonlySet<string>;
  signals: ReadonlySet<string>;
}

export interface ContextStats {
  level: TrimLevel;
  tokensBefore: number;
  tokensAfter: number;
  eventsIncluded: number;
  eventsOmitted: number;
  duplicatesRemoved: number;
  /** Distinct injection indicators found in the untrusted case text of this context. */
  injectionIndicators: number;
}

export interface ContextInjectionFinding extends InjectionIndicator {
  eventId: string | null;
}

export interface BuiltContext {
  context: AgentContext;
  index: ContextIndex;
  /** Text the model was shown per id (events, evidence, claims): the basis for support checks. */
  sourceText: ReadonlyMap<string, string>;
  /** Lower-cased concatenation of all shown text and knowledge labels. */
  allText: string;
  /** SHA-256 of the canonical context: stable under future-only changes (temporal integrity). */
  contextHash: string;
  /** SHA-256 of the context without the prose of events: what makes two requests different requests. */
  structureKey: string;
  /** The prose alone (event text and the evidence and claim text derived from it): the near-match text. */
  prose: string;
  injection: readonly ContextInjectionFinding[];
  stats: ContextStats;
}
