import type { CoachingItem, DecisionFork, EvidenceLink, ForkCategory } from '@caseguard/schemas';
import { riskLevelOf } from '../engine/forks';
import { evidenceLink, truncate } from '../quality/links';
import { formatUtcStamp } from '../util/time';

/** A skill that matched the case, optionally with the pack actions its decision sequence covers. */
export interface CoachingSkill {
  skillId: string;
  name: string;
  matchScore: number;
  coversActions?: readonly string[];
}

export type CoachingSection = 'evidence' | 'reasoning' | 'customer_effort';

/** Constructive, forward-looking titles: they name the practice, never the person. */
export const FORK_LEARNING: Readonly<
  Record<ForkCategory, { title: string; section: CoachingSection }>
> = {
  premature_destructive_action: {
    title: 'Hold disruptive changes until the cause is supported',
    section: 'reasoning',
  },
  premature_escalation: {
    title: 'Collect the minimum evidence before escalating',
    section: 'reasoning',
  },
  assumption_as_fact: {
    title: 'Keep hypotheses worded as hypotheses until evidence supports them',
    section: 'evidence',
  },
  contradiction_ignored: {
    title: 'Revisit the working hypothesis when the evidence turns',
    section: 'evidence',
  },
  high_value_signal_unused: { title: 'Act on strong early signals', section: 'reasoning' },
  disproportionate_customer_effort: {
    title: 'Start with the lightest request that answers the question',
    section: 'customer_effort',
  },
  low_value_action: {
    title: 'Check the record before repeating or re-checking',
    section: 'reasoning',
  },
  alternative_action_available: {
    title: 'Compare each step with the best-ranked safe alternative',
    section: 'reasoning',
  },
};

const firstSentence = (text: string): string => {
  const match = /^(.+?[.!?])(\s|$)/.exec(text.trim());
  return (match?.[1] ?? text).replace(/[.!?]$/, '');
};

const effortWord = (effort: string): string =>
  effort === 'none' ? 'no' : effort.replace('_', ' ');

/** Cuts text to the contract length but, unlike `truncate`, keeps paragraph breaks so hindsight stays visibly separate. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Why the alternative was worth considering, from its decision-time rationale. */
function reasonFor(rationale: string): string {
  const tests = /Tests ([^.]+)\./.exec(rationale)?.[1];
  return tests ? `it tests ${tests}` : `in short: ${firstSentence(rationale)}`;
}

/**
 * One per-fork learning point. The first paragraph uses only what was on record at the decision
 * time ("the record showed X at 11:40; a lighter next step was Y because Z"); hindsight, when
 * present, is a separate paragraph that is labelled as not known at the time.
 */
export function forkLearningItem(
  fork: DecisionFork,
  extra: { skillId: string | null; similarCount: number },
): CoachingItem {
  const learning = FORK_LEARNING[fork.category];
  const alt = fork.alternatives.find((a) => a.safe) ?? fork.alternatives[0];
  const stamp = formatUtcStamp(fork.timestamp);
  const known = `What the record showed at ${stamp}: ${fork.informationAvailable.summary}`;
  const taken =
    fork.actual.kind === null
      ? `The statement recorded at that point was “${truncate(fork.actual.label, 140)}”.`
      : `The step taken was “${fork.actual.label}”.`;
  const better = alt
    ? `A ${alt.customerEffort === 'none' || alt.customerEffort === 'low' ? 'lighter' : 'higher-value'} next step available then was “${alt.label}” (about ${Math.round(alt.timeMinutes)} minutes, ${effortWord(alt.customerEffort)} customer effort, ${riskLevelOf(alt.operationalRisk)} risk; estimated), because ${reasonFor(alt.rationale)}.`
    : 'No safe alternative could be ranked at that moment.';
  const more =
    extra.similarCount > 0
      ? `${extra.similarCount} similar decision${extra.similarCount === 1 ? '' : 's'} appear${extra.similarCount === 1 ? 's' : ''} elsewhere in the case.`
      : '';
  const hindsight = fork.retrospective
    ? `\n\nIn hindsight (not known at the time, shown only to calibrate): ${fork.retrospective.outcomeSummary.replace(/^Hindsight:\s*/i, '')}`
    : '';
  const evidence: EvidenceLink[] = [
    evidenceLink('fork', fork.id, fork.title),
    evidenceLink('event', fork.eventId, fork.actual.label),
  ];
  return {
    title: truncate(`${learning.title} (${stamp})`, 200),
    detail: clip(`${[known, taken, better, more].filter(Boolean).join(' ')}${hindsight}`, 1200),
    evidence,
    skillId: extra.skillId,
  };
}
