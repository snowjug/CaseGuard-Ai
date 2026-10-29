import type { ParseConfidence } from './types';

export interface ConfidenceFactors {
  eventCount: number;
  /** Events whose time of day was not written in the source (inherited, assumed or rolled over). */
  unwrittenTimestamps: number;
  /** Events whose stamp carried no time zone, so an offset was assumed. */
  assumedZoneEvents: number;
  /** Events written by a speaker whose role could not be told. */
  unidentifiedEvents: number;
  /** Events whose type was a neutral default rather than decided by evidence. */
  defaultedTypeEvents: number;
  /** Non-blank input lines that no event claimed. */
  ignoredLines: number;
  nonBlankLines: number;
  reordered: boolean;
  truncatedBodies: number;
  mergedSpeakers: boolean;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Parse-quality estimate in [0.05, 1]. Each factor subtracts a documented amount, so the score
 * is explainable: it measures how much of the draft rests on inference rather than on text
 * the author actually wrote.
 */
export function computeConfidence(f: ConfidenceFactors): ParseConfidence {
  const events = Math.max(1, f.eventCount);
  const reasons: string[] = [];
  let score = 1;
  const penalise = (amount: number, reason: string) => {
    if (amount <= 0) return;
    score -= amount;
    reasons.push(reason);
  };

  penalise(
    0.25 * (f.unwrittenTimestamps / events),
    `${f.unwrittenTimestamps} of ${f.eventCount} event times were not written in the text`,
  );
  penalise(
    f.assumedZoneEvents > 0 ? 0.05 : 0,
    'Time zones were assumed because the text does not state them',
  );
  penalise(
    0.35 * (f.unidentifiedEvents / events),
    `${f.unidentifiedEvents} of ${f.eventCount} events are from speakers whose role could not be told`,
  );
  penalise(
    0.15 * (f.defaultedTypeEvents / events),
    `${f.defaultedTypeEvents} of ${f.eventCount} event types fell back to a neutral default`,
  );
  penalise(
    0.15 * Math.min(1, f.ignoredLines / Math.max(1, f.nonBlankLines)),
    `${f.ignoredLines} of ${f.nonBlankLines} non-blank lines were not part of any event`,
  );
  penalise(f.reordered ? 0.05 : 0, 'Events were not in chronological order and were sorted');
  penalise(f.truncatedBodies > 0 ? 0.1 : 0, `${f.truncatedBodies} very long message(s) were cut`);
  penalise(f.mergedSpeakers ? 0.1 : 0, 'Too many distinct speakers; some were merged by role');

  const clamped = Math.min(1, Math.max(0.05, score));
  const rounded = round2(clamped);
  const level = rounded >= 0.8 ? 'high' : rounded >= 0.55 ? 'medium' : 'low';
  if (reasons.length === 0) {
    reasons.push('Every event time, speaker role and event type was stated or unambiguous');
  }
  return { score: rounded, level, reasons, estimated: true };
}
