import type { ActionValueConfig, AgentName, ValidationOutcome } from '@caseguard/schemas';
import type { CompiledPack, RankingState } from '@caseguard/domain';
import type { IssueKind } from '../agents/outputs';
import type { BuiltContext } from '../context/types';
import type { InjectionScanner } from '../types';

export interface OutputIssue {
  kind: IssueKind;
  /** Stable machine-readable code, e.g. `unknown_event`, `future_reference`. */
  code: string;
  /** JSON path inside the model output, e.g. `steps[0].actionKey`. */
  path: string;
  /** Our own wording; never echoes model text beyond a sanitised id. */
  message: string;
}

/** Hindsight material used only to recognise leakage in outputs. */
export interface LeakGuard {
  futureEventIds: ReadonlySet<string>;
  futureEvidenceIds: ReadonlySet<string>;
  /** Distinctive identifiers (addresses, hostnames, codes) first seen after the boundary or in the resolution. */
  futureTokens: ReadonlySet<string>;
  /** Word n-grams that occur only after the boundary or in the resolution (verbatim-copy detection). */
  futureShingles: ReadonlySet<string>;
}

export interface ValidationLimits {
  /** Serialised output above this many characters is rejected before parsing into the schema. */
  maxOutputChars: number;
  /** Maximum steps in a proposed path (analysis-depth control). */
  maxSteps: number;
  /** Minimum share of claims that must be supported by their citations. */
  minGroundedness: number;
}

export const DEFAULT_VALIDATION_LIMITS: ValidationLimits = {
  maxOutputChars: 64_000,
  maxSteps: 8,
  minGroundedness: 0.6,
};

export interface ValidationContext {
  agent: AgentName;
  built: BuiltContext;
  pack: CompiledPack;
  config: ActionValueConfig;
  limits: ValidationLimits;
  leakGuard: LeakGuard | null;
  /** Knowledge state at the boundary, used for decision-time safety gates (null when not applicable). */
  state: RankingState | null;
  scanInjection: InjectionScanner;
  /** Fingerprints of the instructions sent to the model, to detect prompt leakage in outputs. */
  promptGuard: { templateShingles: ReadonlySet<string>; nonce: string | null };
}

export interface ValidationStats {
  claims: number;
  supportedClaims: number;
  citations: number;
  validCitations: number;
  /** supportedClaims / claims (1 when there are no claims). */
  groundedness: number;
}

export interface ValidationReport<T = unknown> {
  ok: boolean;
  /** Parsed, typed output. Present only when every validator accepted it. */
  output: T | null;
  issues: OutputIssue[];
  kinds: IssueKind[];
  outcome: ValidationOutcome;
  /** One repair attempt with validator feedback may help (schema, citation, grounding, size). */
  repairable: boolean;
  stats: ValidationStats;
}

/** Issues that must never be "repaired": the model is not given a second chance to leak or misbehave. */
export const NON_REPAIRABLE_KINDS: ReadonlySet<IssueKind> = new Set<IssueKind>([
  'temporal',
  'policy',
  'injection',
]);
