import {
  FORK_CATEGORY_LABELS,
  type AnalysisRun,
  type CaseDetail,
  type CoachingReport,
  type EvidenceLink,
  type ForkListResponse,
  type MetricEstimate,
  type QualityAssessment,
  type QualityBand,
} from '@caseguard/schemas';
import type { BadgeStatus, ScoreStatus } from '@caseguard/ui';
import { betterAlternative, earliestFork } from './forks';
import { evidenceLinks, eventLinks, uniqueLinks } from './links';
import { plural } from './words';

/** The words and status of each quality band. The status carries the icon and pattern, so no band is colour alone. */
export const BAND_WORDS: Record<
  QualityBand,
  { label: string; badge: BadgeStatus; ring: ScoreStatus; meaning: string }
> = {
  strong: {
    label: 'Strong',
    badge: 'productive',
    ring: 'good',
    meaning: 'The investigation was well supported at nearly every step.',
  },
  adequate: {
    label: 'Adequate',
    badge: 'neutral',
    ring: 'watch',
    meaning: 'The investigation was sound overall, with room to improve.',
  },
  needs_attention: {
    label: 'Needs attention',
    badge: 'uncertain',
    ring: 'watch',
    meaning: 'Several steps were not well supported by what was on record.',
  },
  poor: {
    label: 'Poor',
    badge: 'unsupported',
    ring: 'poor',
    meaning: 'Many steps were not well supported by what was on record.',
  },
};

const whole = (value: number): number => Math.round(value);

/** The moment the review calls the earliest important missed one: the first decision point with a better step available. */
export interface MissedMoment {
  forkId: string;
  eventId: string;
  at: string;
  title: string;
  /** What happened, in the engine's own words. */
  summary: string;
  categoryLabel: string;
  /** What was done at that moment. */
  didLabel: string;
  /** What was already on record at that moment. */
  knownSummary: string;
  knownLinks: EvidenceLink[];
  /** The better-supported step that was available, when the engine named one. */
  betterLabel: string | null;
}

/** The earliest important missed moment of the case, or `null` when no decision point stood out. */
export function deriveMissedMoment(forks: ForkListResponse): MissedMoment | null {
  const fork = earliestFork(forks);
  if (!fork) return null;
  return {
    forkId: fork.id,
    eventId: fork.eventId,
    at: fork.timestamp,
    title: fork.title,
    summary: fork.summary,
    categoryLabel: FORK_CATEGORY_LABELS[fork.category],
    didLabel: fork.actual.label,
    knownSummary: fork.informationAvailable.summary,
    knownLinks: uniqueLinks([
      ...eventLinks(fork.informationAvailable.eventIds),
      ...evidenceLinks(fork.informationAvailable.evidenceIds),
    ]),
    betterLabel: betterAlternative(fork)?.label ?? null,
  };
}

/** The avoidable support effort, read from the metric the engine computed (an estimate, with its own range). */
export interface EffortFigure {
  display: string;
  low: number | null;
  high: number | null;
  confidenceLabel: string;
}

export function deriveEffort(metrics: readonly MetricEstimate[]): EffortFigure | null {
  const metric = metrics.find((item) => item.key === 'avoidable_support_effort');
  if (!metric || metric.value === null) return null;
  return {
    display: metric.display,
    low: metric.low,
    high: metric.high,
    confidenceLabel: `${metric.confidence} confidence`,
  };
}

export interface VerdictModel {
  band: QualityBand;
  bandLabel: string;
  badge: BadgeStatus;
  ring: ScoreStatus;
  meaning: string;
  score: number;
  low: number;
  high: number;
  /** `36 out of 100`. */
  scoreText: string;
  /** `plausible range 32 to 39`. */
  rangeText: string;
  /** One sentence that states the result with its range and says it is an estimate. */
  headline: string;
  /** True when nothing could be assessed: the score is then a placeholder and is not shown as a result. */
  placeholder: boolean;
  /** Sentences built from the figures of the case, nothing else. */
  facts: string[];
  /** The coaching summary in the engine's own words, or `null` when the coaching report is not available. */
  coachingSummary: string | null;
  effort: EffortFigure | null;
  uncertaintyNote: string;
  configVersion: string;
}

const isPlaceholder = (quality: QualityAssessment): boolean =>
  quality.dimensions.every((dimension) => dimension.weight === 0);

export interface VerdictInput {
  quality: QualityAssessment;
  coaching: CoachingReport | null;
  forks: ForkListResponse | null;
  detail: CaseDetail;
  metrics: readonly MetricEstimate[] | null;
}

/** The verdict: the quality band and range, the result in words, and the figures it rests on. Nothing is invented. */
export function deriveVerdict(input: VerdictInput): VerdictModel {
  const { quality, coaching, forks, detail, metrics } = input;
  const band = BAND_WORDS[quality.band];
  const score = whole(quality.compositeScore);
  const low = whole(quality.compositeLow);
  const high = whole(quality.compositeHigh);
  const scoreText = `${score} out of 100`;
  const rangeText = `plausible range ${low} to ${high}`;
  const facts: string[] = [];
  if (forks) {
    facts.push(
      forks.items.length === 0
        ? 'No decision point stood out as having a clearly better step available.'
        : `${plural(forks.items.length, 'decision point')} had a better-supported step available at the time.`,
    );
  }
  facts.push(
    detail.status === 'open'
      ? 'The case is still open, so this reviews the record so far.'
      : 'The case is resolved, so this reviews the whole record.',
  );
  return {
    band: quality.band,
    bandLabel: band.label,
    badge: band.badge,
    ring: band.ring,
    meaning: band.meaning,
    score: quality.compositeScore,
    low: quality.compositeLow,
    high: quality.compositeHigh,
    scoreText,
    rangeText,
    headline: `Case quality is ${band.label.toLowerCase()}: about ${scoreText} (${rangeText}). This is an estimate.`,
    placeholder: isPlaceholder(quality),
    facts,
    coachingSummary: coaching ? coaching.summary : null,
    effort: metrics ? deriveEffort(metrics) : null,
    uncertaintyNote: quality.uncertaintyNote,
    configVersion: quality.configVersion,
  };
}

/** A short statement of who or what produced the analysis, read from the run (never assumed). */
export interface Producer {
  kind: 'rules' | 'model' | 'unknown';
  /** One sentence for the method notes. */
  sentence: string;
}

export function describeProducer(run: AnalysisRun | null): Producer {
  if (!run) {
    return { kind: 'unknown', sentence: 'The analysis run behind this review could not be read.' };
  }
  const pack = `${run.knowledgePackId} version ${run.knowledgePackVersion}`;
  if (run.provider === 'deterministic') {
    return {
      kind: 'rules',
      sentence: `Fixed rules produced this review (the ${pack} knowledge pack). No language model was involved.`,
    };
  }
  return {
    kind: 'model',
    sentence: `A language model (${run.model}) produced parts of this review, checked against the ${pack} knowledge pack.`,
  };
}
