/**
 * What the engine said about one case, as plain data. This is the only thing the measures read: they never import the
 * engine, so they can be tested with made-up outputs and cannot change what the engine does.
 */

/** Why an expected signal was not reported, decided from how the pack's detectors are defined (never from the wording). */
export type MissCause = 'structured-only' | 'type-or-role-gate' | 'wording';

export interface EngineEventInfo {
  readonly key: string;
  readonly type: string;
  /** The participant role of the author, as the engine sees it. */
  readonly role: string;
  /** The author's `who` in the case file (`engineer` events are the ones whose actions are labelled). */
  readonly who: string;
}

export interface EngineFork {
  readonly event: string;
  /** The primary category first, then the additional ones. */
  readonly categories: readonly string[];
  readonly severity: string;
  readonly earliest: boolean;
}

export interface EngineConflict {
  readonly class: string;
  /** Both sides, the earlier one first. */
  readonly events: readonly [string, string];
  readonly subject: string;
}

export interface EngineHypothesis {
  readonly key: string;
  readonly prior: number;
  readonly confidence: number;
}

/** What `verifyExcerpt` found for the evidence and claims that carry a source reference. */
export interface CitationCounts {
  readonly total: number;
  readonly verified: number;
  readonly mismatch: number;
  readonly notCheckable: number;
}

/** Quality improvements, warnings and coaching suggestions. */
export interface RecommendationCounts {
  readonly total: number;
  readonly withEvidence: number;
  /** Without evidence ids, and flagged by the engine as general guidance. */
  readonly general: number;
}

export interface CounterfactualOutput {
  /** False when the engine had no eligible earliest decision point to simulate from. */
  readonly simulated: boolean;
  /** Best relative improvement over the recorded path among the simulated strategies (0.2 is 20% less time). */
  readonly timeToDiagnosisGain: number | null;
  readonly customerEffortGain: number | null;
  /** At least `CLEARLY_BETTER` on either measure. */
  readonly clearlyBetter: boolean;
}

/** A relative improvement of at least this much counts as clearly better. */
export const CLEARLY_BETTER = 0.1;

export interface EngineCaseOutput {
  readonly caseId: string;
  /** No knowledge pack exists for the workload: the engine refuses the case. */
  readonly refused: boolean;
  /** The events in the order the engine reads them (by time). */
  readonly events: readonly EngineEventInfo[];
  /** `eventKey|signalId` for every evidence item the engine reports, sorted. */
  readonly signals: readonly string[];
  /** `eventKey|actionId` for every action the engine maps to a pack action, sorted. */
  readonly actions: readonly string[];
  readonly forks: readonly EngineFork[];
  readonly earliestFork: string | null;
  /** `not_available` until the engine reports conflicts. */
  readonly conflicts: 'not_available' | readonly EngineConflict[];
  readonly hypotheses: readonly EngineHypothesis[];
  readonly citations: CitationCounts;
  /** Null when this run did not compute them. */
  readonly recommendations: RecommendationCounts | null;
  readonly qualityBand: string | null;
  /** Null when this run did not simulate counterfactuals (they are slow, so opt-in). */
  readonly counterfactual: CounterfactualOutput | null;
  /** For the expected-but-not-reported signals the caller asked about: why the engine could not have read them. */
  readonly missCauses: Readonly<Record<string, MissCause>>;
  /** Everything an order of events must not change, as one string. */
  readonly fingerprint: string;
}

export const emptyCitations: CitationCounts = {
  total: 0,
  verified: 0,
  mismatch: 0,
  notCheckable: 0,
};

/** What a refused case looks like: the engine produced nothing. */
export function refusedOutput(
  caseId: string,
  events: readonly EngineEventInfo[],
): EngineCaseOutput {
  return {
    caseId,
    refused: true,
    events,
    signals: [],
    actions: [],
    forks: [],
    earliestFork: null,
    conflicts: 'not_available',
    hypotheses: [],
    citations: emptyCitations,
    recommendations: null,
    qualityBand: null,
    counterfactual: null,
    missCauses: {},
    fingerprint: 'refused',
  };
}
