import { DEFAULT_EFFORT_MINUTES, type Range } from '@caseguard/schemas';
import { findDiagnosisIndex } from '../engine/hindsight';
import type { DeterministicAnalysis } from '../engine/pipeline';
import { satisfiedSetAt } from '../engine/requirements';
import type { CompiledPack } from '../knowledge/compile';
import { round } from '../util/math';
import { minutesBetween } from '../util/time';
import { evidenceCompleteness } from './replay';

/** What actually happened from one moment to the recorded diagnosis (measured from the case record). */
export interface ActualMeasure {
  fromEventId: string;
  fromAt: string;
  reachedDiagnosis: boolean;
  diagnosisEventId: string | null;
  diagnosisAt: string | null;
  timeToDiagnosisMinutes: number;
  customerEffortMinutes: number;
  customerInteractions: number;
  actionCount: number;
  tokenEstimate: number;
  evidenceCompleteness: number;
  actionKeys: (string | null)[];
}

/**
 * The decision moment a skill is judged from: the earliest eligible fork of the case, or the first
 * action the engineer took when the case had no fork (the initial triage choice).
 */
export function defaultDecisionEventId(analysis: DeterministicAnalysis): string | null {
  const fork = analysis.forks.find((f) => f.eligibility.eligible);
  return fork?.eventId ?? analysis.actions[0]?.eventId ?? null;
}

/**
 * Measures the recorded path from `fromIndex` (the index of the first event that counts) to the first
 * moment the case was actually diagnosed. Post-hoc: it reads the whole record and feeds nothing back
 * into any decision.
 */
export function measureActualPath(args: {
  analysis: DeterministicAnalysis;
  pack: CompiledPack;
  fromIndex: number;
  /** Timestamp the elapsed time is measured from (the decision moment or the plan time). */
  fromAt: string;
  minimumEvidence: readonly string[];
}): ActualMeasure | null {
  const { analysis, pack, fromIndex, fromAt, minimumEvidence } = args;
  const events = analysis.view.events;
  const first = events[fromIndex];
  if (!first) return null;
  const diagnosis = findDiagnosisIndex(
    pack,
    analysis.timeline,
    analysis.requirementStates,
    fromIndex,
  );
  const endIndex = diagnosis?.index ?? events.length - 1;
  const end = events[endIndex] ?? first;
  const window = analysis.actions.filter((a) => a.sequence >= fromIndex && a.sequence <= endIndex);
  const tokens = window.reduce(
    (sum, a) =>
      sum +
      (a.tokenEstimate > 0
        ? a.tokenEstimate
        : a.actionKey
          ? (pack.actions.get(a.actionKey)?.tokenEstimate ?? 0)
          : 0),
    0,
  );
  return {
    fromEventId: first.id,
    fromAt,
    reachedDiagnosis: diagnosis !== null,
    diagnosisEventId: diagnosis ? end.id : null,
    diagnosisAt: diagnosis ? end.timestamp : null,
    timeToDiagnosisMinutes: round(Math.max(0, minutesBetween(fromAt, end.timestamp)), 1),
    customerEffortMinutes: window.reduce((s, a) => s + DEFAULT_EFFORT_MINUTES[a.customerEffort], 0),
    customerInteractions: window.filter((a) => a.customerEffort !== 'none').length,
    actionCount: window.length,
    tokenEstimate: tokens,
    evidenceCompleteness: round(
      evidenceCompleteness(satisfiedSetAt(analysis.requirementStates, endIndex), minimumEvidence),
      3,
    ),
    actionKeys: window.map((a) => a.actionKey),
  };
}

/** Signed difference `reference - observed` per bound: positive means the observed value is lower. */
export function differenceRange(reference: Range, observed: number): Range {
  return {
    low: round(reference.low - observed, 1),
    mid: round(reference.mid - observed, 1),
    high: round(reference.high - observed, 1),
  };
}
