import {
  DEFAULT_ACTION_VALUE_CONFIG,
  RESPONSIBLE_USE_NOTICE,
  type ActionValueConfig,
  type CaseWarning,
  type CoachingItem,
  type CoachingReport,
  type DecisionFork,
  type Level,
} from '@caseguard/schemas';
import type { EngineContext } from '../engine/context';
import type { DeterministicAnalysis } from '../engine/pipeline';
import type { CompiledPack } from '../knowledge/compile';
import type { QualityReview } from '../quality/types';
import { isAssessed } from '../quality/checks';
import { evidenceLink, truncate, uniqueLinks } from '../quality/links';
import { buildCheckpoint } from '../warnings/checkpoint';
import { viewWarningsAsOf } from '../warnings/replay';
import { bestNextStep, describeStep, toSuggestedStep } from '../warnings/suggest';
import { DEFAULT_LIVE_WARNING_OPTIONS } from '../warnings/types';
import { formatUtcStamp } from '../util/time';
import { FORK_LEARNING, forkLearningItem, type CoachingSkill } from './templates';

export interface CoachingInput {
  analysis: DeterministicAnalysis;
  pack: CompiledPack;
  ctx: EngineContext;
  review: QualityReview;
  /** Warnings from the live replay; the top-ranked one still open at the view boundary shapes the next step. */
  warnings?: readonly CaseWarning[];
  /** Skills that matched the case (best first is not required). */
  skills?: readonly CoachingSkill[];
  config?: ActionValueConfig;
  /** True for synthetic cases; adds an explicit statement to the limitations. */
  synthetic?: boolean;
}

const COACHING_NOTICE = `Supportive decision support, not a performance rating. ${RESPONSIBLE_USE_NOTICE}`;

const COMMUNICATION_ADVICE: Readonly<Record<string, { title: string; tip: string }>> = {
  'CC-1': {
    title: 'Acknowledge the case promptly',
    tip: 'A short acknowledgement with the next step and a time for the next update is enough at this stage.',
  },
  'CC-2': {
    title: 'Say what happens next in every message',
    tip: 'Close each message with what will be done with the answer and when the customer will hear back.',
  },
  'CC-3': {
    title: 'Reply sooner to messages that expect an answer',
    tip: 'Even a brief status reply, sent while the diagnosis continues, tells the customer the case is moving.',
  },
  'CC-4': {
    title: 'Keep the customer informed without being asked',
    tip: 'Agreeing an update rhythm at the start means the customer never has to ask what is happening.',
  },
};

function strengths(
  review: QualityReview,
  analysis: DeterministicAnalysis,
  pack: CompiledPack,
): CoachingItem[] {
  const items: { weight: number; item: CoachingItem }[] = [];
  for (const dimension of review.dimensions) {
    for (const check of dimension.subChecks) {
      if (!check.determinable || check.score < 0.85 || check.weight <= 0) continue;
      items.push({
        weight: dimension.weight * check.weight * check.score,
        item: {
          title: `Done well: ${check.label}`,
          detail: truncate(check.note, 1200),
          evidence: check.evidence.slice(0, 4),
          skillId: null,
        },
      });
    }
  }
  const decisive = [...analysis.actions]
    .filter(
      (a) =>
        a.relativeValueAtDecision === 1 &&
        (a.kind === 'network_diagnostic' ||
          a.kind === 'client_diagnostic' ||
          a.kind === 'log_query'),
    )
    .pop();
  if (decisive) {
    items.push({
      weight: 1,
      item: {
        title: 'A well-chosen test at the decisive moment',
        detail: truncate(
          `At ${formatUtcStamp(decisive.startedAt)} “${decisive.label}” was the highest-value safe step available given the evidence on record (${decisive.customerEffort === 'none' ? 'no' : decisive.customerEffort.replace('_', ' ')} customer effort, estimated).`,
          1200,
        ),
        evidence: [evidenceLink('action', decisive.id, decisive.label)],
        skillId: null,
      },
    });
  }
  const sorted = items
    .sort((a, b) => b.weight - a.weight || (a.item.title < b.item.title ? -1 : 1))
    .map((i) => i.item)
    .slice(0, 5);
  if (sorted.length > 0) return sorted;
  if (analysis.view.events.length === 0) return [];
  const name = pack.pack.title;
  return [
    {
      title: 'A reviewable record',
      detail: `The case record gives enough detail to review the investigation against ${name}.`,
      evidence: [],
      skillId: null,
    },
  ];
}

export function buildCoachingReport(input: CoachingInput): CoachingReport {
  const { analysis, pack, ctx, review } = input;
  const config = input.config ?? DEFAULT_ACTION_VALUE_CONFIG;
  const skills = [...(input.skills ?? [])]
    .sort((a, b) => b.matchScore - a.matchScore || (a.skillId < b.skillId ? -1 : 1))
    .slice(0, 3);
  const skillFor = (actionKey: string | undefined): string | null =>
    (actionKey ? skills.find((s) => s.coversActions?.includes(actionKey)) : undefined)?.skillId ??
    null;

  const forks = [...analysis.forks];
  const top: DecisionFork | undefined = [...forks].sort(
    (a, b) => b.impactScore - a.impactScore || a.sequence - b.sequence,
  )[0];
  const countSame = (fork: DecisionFork): number =>
    forks.filter((f) => f.category === fork.category && f.id !== fork.id).length;
  const bestSafe = (fork: DecisionFork) => fork.alternatives.find((a) => a.safe)?.actionKey;
  const missedOpportunity = top
    ? forkLearningItem(top, {
        skillId:
          skillFor(bestSafe(top)) ??
          (skills[0] && skills[0].matchScore >= 0.5 ? skills[0].skillId : null),
        similarCount: countSame(top),
      })
    : null;

  // One learning point per remaining category (the highest-impact fork of it), grouped by section.
  const covered = new Set(top ? [top.category] : []);
  const perCategory = new Map<string, DecisionFork>();
  for (const fork of [...forks].sort(
    (a, b) => b.impactScore - a.impactScore || a.sequence - b.sequence,
  )) {
    if (!covered.has(fork.category) && !perCategory.has(fork.category))
      perCategory.set(fork.category, fork);
  }
  const sectionItems = (section: 'evidence' | 'reasoning' | 'customer_effort'): CoachingItem[] =>
    [...perCategory.values()]
      .filter((f) => FORK_LEARNING[f.category].section === section)
      .slice(0, 3)
      .map((f) =>
        forkLearningItem(f, { skillId: skillFor(bestSafe(f)), similarCount: countSame(f) }),
      );

  const communicationStepAction = pack.pack.actions.find((a) => a.valueClass === 'communication');
  const stepText = communicationStepAction
    ? ` The lightest way to do this: ${describeStep(toSuggestedStep(communicationStepAction))}`
    : '';
  const communication: CoachingItem[] = review.dimensions
    .filter((d) => d.key === 'customer_communication')
    .flatMap((d) => d.subChecks)
    .filter((c) => c.determinable && c.score < 0.7 && COMMUNICATION_ADVICE[c.id] !== undefined)
    .slice(0, 3)
    .map((c) => {
      const advice = COMMUNICATION_ADVICE[c.id];
      return {
        title: advice?.title ?? c.label,
        detail: truncate(`${c.note} ${advice?.tip ?? ''}${stepText}`, 1200),
        evidence: c.evidence.slice(0, 4),
        skillId: null,
      };
    });

  const events = analysis.view.events;
  const closed = review.dimensions.some(
    (d) => d.key === 'resolution_validation' && d.subChecks.some((c) => c.determinable),
  );
  // Only prompts that were already open at the view boundary can shape the advice (as-of safe).
  const openPrompt = viewWarningsAsOf(input.warnings ?? [], analysis.view.asOf).find(
    (w) => w.state === 'open',
  );
  let recommendedNextAction: CoachingItem | null = null;
  if (openPrompt) {
    recommendedNextAction = {
      title: 'Suggested next step',
      detail: truncate(
        `The most important open prompt at ${formatUtcStamp(analysis.view.asOf)} is “${openPrompt.title}”. ${openPrompt.suggestedAction}`,
        1200,
      ),
      evidence: uniqueLinks(openPrompt.evidence, 6),
      skillId: null,
    };
  } else if (!closed && events.length > 0) {
    const cp = buildCheckpoint({
      analysis,
      pack,
      config,
      options: DEFAULT_LIVE_WARNING_OPTIONS,
      index: events.length - 1,
      now: analysis.view.asOf,
    });
    const step = bestNextStep(cp);
    const leader = Object.entries(cp.belief).sort((a, b) => b[1] - a[1])[0];
    if (step) {
      recommendedNextAction = {
        title: 'Suggested next step',
        detail: truncate(
          `Based on the evidence on record at ${formatUtcStamp(analysis.view.asOf)}${leader ? ` (leading hypothesis “${cp.hypothesisName(leader[0])}”, ${Math.round(leader[1] * 100)}% model estimate)` : ''}: ${describeStep(step)}`,
          1200,
        ),
        evidence: leader
          ? [evidenceLink('hypothesis', leader[0], cp.hypothesisName(leader[0]))]
          : [],
        skillId: skillFor(step.actionKey),
      };
    }
  } else if (review.improvements[0]) {
    const improvement = review.improvements[0];
    recommendedNextAction = {
      title: `For the next similar case: ${improvement.title}`,
      detail: truncate(improvement.description, 1200),
      evidence: uniqueLinks(improvement.evidence, 6),
      skillId: null,
    };
  } else if (closed && forks.length === 0) {
    recommendedNextAction = {
      title: 'Share what worked',
      detail:
        'The path in this case was sound and light on the customer. Consider offering it as a candidate for SkillDNA so others can reuse it; any skill still needs reviewer approval before it is published.',
      evidence: [],
      skillId: null,
    };
  }

  const wentWell = strengths(review, analysis, pack);
  const assessed = review.dimensions.some(isAssessed);
  const diagnosis = analysis.hypotheses
    .filter((h) => h.currentStatus === 'confirmed')
    .sort((a, b) => b.currentConfidence - a.currentConfidence)[0];
  const widthBand = review.compositeHigh - review.compositeLow;
  // A rule-based review never claims high confidence: it reads the written record only.
  const level: Level = events.length < 6 || widthBand > 25 ? 'low' : 'medium';
  const asOfNote = review.asOf
    ? ` This report reflects only what was on record up to ${formatUtcStamp(review.asOf)}.`
    : '';
  const summary = truncate(
    [
      'This is a supportive, estimate-based review of how the case unfolded, written to help with reflection; it is not a rating of a person.',
      diagnosis
        ? `The investigation reached a confirmed diagnosis (“${diagnosis.name}”, model estimate ${Math.round(diagnosis.currentConfidence * 100)}%).`
        : 'The investigation has not yet reached a confirmed diagnosis in this view.',
      wentWell.length > 0
        ? `What went well: ${wentWell
            .slice(0, 3)
            .map((w) => w.title.replace(/^Done well: /, ''))
            .join('; ')}.`
        : 'There is not yet enough on record to say what went well.',
      missedOpportunity
        ? `The most useful opportunity: ${missedOpportunity.title.replace(/ \(.*\)$/, '')}.`
        : analysis.actions.length === 0
          ? 'No investigative step is on record yet, so there is no decision to review.'
          : 'No decision point stood out as having a clearly better safe alternative.',
      assessed
        ? `Case Quality Index (estimate): ${Math.round(review.compositeScore)} of 100, plausible range ${Math.round(review.compositeLow)}–${Math.round(review.compositeHigh)}.${asOfNote}`
        : `The Case Quality Index cannot be estimated yet because nothing in this view can be assessed.${asOfNote}`,
    ].join(' '),
    1500,
  );

  return {
    caseId: ctx.caseId,
    analysisRunId: ctx.runId,
    generatedAt: ctx.now,
    summary,
    wentWell,
    missedOpportunity,
    evidenceQuality: sectionItems('evidence'),
    reasoningImprovements: sectionItems('reasoning'),
    communicationImprovements: communication,
    customerEffortImprovements: sectionItems('customer_effort'),
    recommendedNextAction,
    relevantSkills: skills.map((s) => ({
      skillId: s.skillId,
      name: s.name,
      matchScore: Math.min(1, Math.max(0, s.matchScore)),
    })),
    confidence: {
      level,
      rationale: `Based on ${events.length} recorded events and ${forks.length} decision ${forks.length === 1 ? 'point' : 'points'}; the quality score range is ${Math.round(review.compositeLow)}–${Math.round(review.compositeHigh)}. All confidence values are model estimates from knowledge pack ${pack.pack.id} v${pack.pack.version}.`,
    },
    limitations: [
      `Scores and comparisons are model estimates from the authored knowledge pack (${pack.pack.id} v${pack.pack.version}), not measurements.`,
      'Alternatives shown are suggestions available at the time from the knowledge pack; they were not executed and may not fit every environment.',
      'The analysis reads the written case record only; context from calls, tooling or experience that was not written down is invisible to it.',
      'Statements labelled “In hindsight” use information that was not available when the decision was made; they are shown to calibrate, never to judge the decision.',
      ...(input.synthetic === true
        ? [
            'This case is synthetic; figures demonstrate the method and are not evidence of real-world performance.',
          ]
        : []),
      ...(review.asOf
        ? [`Only information recorded up to ${formatUtcStamp(review.asOf)} was used.`]
        : []),
    ],
    notice: COACHING_NOTICE,
  };
}
