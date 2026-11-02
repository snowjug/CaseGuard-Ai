import {
  ACTION_KIND_LABELS,
  FORK_CATEGORY_LABELS,
  type DecisionFork,
  type EvidenceLink,
  type ForkListResponse,
  type Level,
} from '@caseguard/schemas';
import { formatDuration, type BadgeStatus } from '@caseguard/ui';
import { EFFORT_LABELS, LEVEL_LABELS } from '../../reasoning/labels';
import { betterAlternative, orderForks } from './forks';
import { evidenceLinks, eventLinks, uniqueLinks } from './links';
import { describeRange } from './words';

/** How many decision points the review explains before the rest are offered on request. */
export const DECISION_POINTS_SHOWN = 3;

/** How much a decision point mattered, in words and as the badge status that carries its icon and pattern. */
export const IMPACT_WORDS: Record<Level, { label: string; badge: BadgeStatus }> = {
  high: { label: 'High impact', badge: 'unsupported' },
  medium: { label: 'Medium impact', badge: 'uncertain' },
  low: { label: 'Low impact', badge: 'neutral' },
};

export interface DecisionPointModel {
  /** From 1, earliest first: the number the chronology strip uses. */
  number: number;
  forkId: string;
  eventId: string;
  at: string;
  title: string;
  isEarliest: boolean;
  impactLabel: string;
  impactBadge: BadgeStatus;
  categoryLabel: string;
  /** What happened, in the engine's own words. */
  whatHappened: string;
  /** What was already on record at that moment. */
  known: { summary: string; links: EvidenceLink[]; eventCount: number; evidenceCount: number };
  /** Plain-language names of what had not yet been collected or did not yet exist. */
  notYetKnown: string[];
  /** What was done at that moment. */
  did: { label: string; kindLabel: string | null; effortLabel: string; destructive: boolean };
  /** The better-supported step that was available, or `null` when the engine found no safe alternative. */
  better: {
    label: string;
    kindLabel: string;
    rationale: string;
    effortLabel: string;
    /** The evidence on record at that moment that supports the alternative. */
    links: EvidenceLink[];
  } | null;
  /** The engine's estimate of what each choice would have cost, with its own wording of the difference. */
  estimate: {
    didTime: string;
    betterTime: string | null;
    deltaSummary: string;
  };
  uncertainty: { levelLabel: string; rationale: string };
}

const minutes = (value: number): string => formatDuration(value);

function describe(fork: DecisionFork, number: number): DecisionPointModel {
  const better = betterAlternative(fork);
  const actual = fork.consequences.actual;
  const best = fork.consequences.bestAlternative;
  return {
    number,
    forkId: fork.id,
    eventId: fork.eventId,
    at: fork.timestamp,
    title: fork.title,
    isEarliest: fork.isEarliestMeaningful,
    impactLabel: IMPACT_WORDS[fork.severity].label,
    impactBadge: IMPACT_WORDS[fork.severity].badge,
    categoryLabel: FORK_CATEGORY_LABELS[fork.category],
    whatHappened: fork.summary,
    known: {
      summary: fork.informationAvailable.summary,
      links: uniqueLinks([
        ...eventLinks(fork.informationAvailable.eventIds),
        ...evidenceLinks(fork.informationAvailable.evidenceIds),
      ]),
      eventCount: fork.informationAvailable.eventIds.length,
      evidenceCount: fork.informationAvailable.evidenceIds.length,
    },
    notYetKnown: fork.informationUnavailable,
    did: {
      label: fork.actual.label,
      kindLabel: fork.actual.kind ? ACTION_KIND_LABELS[fork.actual.kind] : null,
      effortLabel: EFFORT_LABELS[fork.actual.customerEffort],
      destructive: fork.actual.destructive,
    },
    better: better
      ? {
          label: better.label,
          kindLabel: ACTION_KIND_LABELS[better.kind],
          rationale: better.rationale,
          effortLabel: EFFORT_LABELS[better.customerEffort],
          links: evidenceLinks(better.supportingEvidenceIds),
        }
      : null,
    estimate: {
      didTime: describeRange(actual.timeToUsefulEvidenceMinutes, minutes),
      betterTime: best ? describeRange(best.timeToUsefulEvidenceMinutes, minutes) : null,
      deltaSummary: fork.consequences.deltaSummary,
    },
    uncertainty: {
      levelLabel: `${LEVEL_LABELS[fork.uncertainty.level]} uncertainty`,
      rationale: fork.uncertainty.rationale,
    },
  };
}

/** The decision points explained in plain language, earliest first. */
export function deriveDecisionPoints(forks: ForkListResponse): DecisionPointModel[] {
  return orderForks(forks.items).map((fork, index) => describe(fork, index + 1));
}
