import {
  PROVENANCE_MAX_LINKS,
  type DecisionFork,
  type EvidenceLink,
  type PathMetrics,
  type Range,
  type SkillContent,
  type SkillExpectedBenefit,
  type SkillMatch,
  type SkillMatchStep,
  type SkillOverlay,
  type SkillOverlayRow,
} from '@caseguard/schemas';
import { compareIso } from '../util/time';
import { clip, uniq } from './util';

/*
 * "Recorded versus with the skill": what a matched skill would have changed for one case, set beside what
 * the case recorded. It is a comparison laid over the analysis, not a second analysis: the inputs are
 * stored data (the match, the version of the skill, the decision points, the engine's own figures for the
 * path the case took) and nothing here reads or writes anything else. The case's recorded analysis is
 * never altered by it, which `labels.recordedAnalysisUnchanged` says and the API tests prove.
 *
 * THE DECISION POINT. The skill's first recommended step is the first step of its plan that names an
 * action. The decision point of the case is a decision point at which that action was one of the
 * alternatives the engine found open (safe and not blocked), because that is where the skill would have
 * changed what the case did. When several qualify, the one the skill was distilled from wins (its saving
 * was estimated at exactly that moment); otherwise the earliest one at which the case did something else;
 * otherwise the earliest. No decision point qualifies: there is none, and the overlay says so.
 *
 * THE FORMULA. Every figure of `withSkill` is the recorded figure minus the skill's own estimated saving,
 * range against range (`subtractSaving`): low = recorded low - saving high, mid = recorded mid - saving
 * mid, high = recorded high - saving low, never below zero. A skill states its saving in time to
 * diagnosis, customer effort and tokens, each measured from the decision point of the case it was distilled
 * from (see `extraction.ts`), so the recorded figure is the engine's figure for the path the case took from
 * ITS decision point in that same measure. For the case the skill came from, that reproduces the skill's
 * own replay exactly. For another case the saving is assumed to carry over, and the overlay says so.
 *
 * WHAT IS WITHHELD. The path a case took from a decision point includes events that come later, so its
 * figures are shown only when no event of the case lies after the instant of the match (the whole record).
 * Before that a row has no recorded figure and no with-skill figure, and says why.
 */

/** What a client is given of the engine's figures for the path the case took from the decision point. */
export interface RecordedPathInput {
  /** True when no event of the case lies after the instant of the match. */
  readonly wholeRecord: boolean;
  /** The engine's figures for the recorded path from the decision point; null when it has none. */
  readonly metrics: PathMetrics | null;
}

export interface SkillOverlayInput {
  readonly caseId: string;
  readonly match: SkillMatch;
  /** The content of the version of the skill the match is for. */
  readonly content: SkillContent;
  /** The decision point `chooseDecisionPoint` picked, or null. */
  readonly decisionPoint: DecisionFork | null;
  /** Every decision point of the case as of the match, for the sentence that says there is none. */
  readonly decisionPointCount: number;
  readonly recorded: RecordedPathInput;
}

/** The first step of the skill's plan that names an action: what the skill would have the engineer do first. */
export function firstRecommendedStep(
  match: Pick<SkillMatch, 'recommendedSteps'>,
): SkillMatchStep | null {
  return match.recommendedSteps.find((step) => step.actionKey !== null) ?? null;
}

/** Whether the engine found this action open at the decision point (safe and not blocked). */
const offersAction = (fork: DecisionFork, actionKey: string): boolean =>
  fork.alternatives.some(
    (alternative) =>
      alternative.actionKey === actionKey &&
      alternative.safe &&
      alternative.blockedReasons.length === 0,
  );

/**
 * The decision point of the case at which the skill would have mattered (see the rules at the top of the
 * file), or null when the plan names no action or none of the decision points had it open.
 */
export function chooseDecisionPoint(input: {
  readonly forks: readonly DecisionFork[];
  readonly match: Pick<SkillMatch, 'recommendedSteps'>;
  readonly content: Pick<SkillContent, 'provenance'>;
}): DecisionFork | null {
  const action = firstRecommendedStep(input.match)?.actionKey ?? null;
  if (action === null) return null;
  const offered = input.forks
    .filter((fork) => offersAction(fork, action))
    .sort((a, b) => compareIso(a.timestamp, b.timestamp) || a.sequence - b.sequence);
  const origin = input.content.provenance?.forkId ?? null;
  return (
    offered.find((fork) => fork.id === origin) ??
    offered.find((fork) => fork.actual.actionKey !== action) ??
    offered[0] ??
    null
  );
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * What remains of a recorded range once the skill's estimated saving is taken off it, range against range:
 * the lowest the path could have been is the lowest recorded figure less the biggest saving, the highest is
 * the highest recorded figure less the smallest saving. Held at zero (a path cannot cost less than nothing)
 * and rounded to one decimal; `heldAtZero` says when that mattered. A saving that is negative at its low end
 * (the skill might have been worse) raises the high end above the recorded figure, as it should.
 */
export function subtractSaving(
  recorded: Range,
  saved: Range,
): { range: Range; heldAtZero: boolean } {
  const raw = {
    low: recorded.low - saved.high,
    mid: recorded.mid - saved.mid,
    high: recorded.high - saved.low,
  };
  const held = (value: number): number => round1(Math.max(0, value));
  return {
    range: { low: held(raw.low), mid: held(raw.mid), high: held(raw.high) },
    heldAtZero: raw.low < 0 || raw.mid < 0 || raw.high < 0,
  };
}

interface RowSpec {
  readonly key: SkillOverlayRow['key'];
  readonly label: string;
  readonly unit: SkillOverlayRow['unit'];
  readonly recorded: (metrics: PathMetrics) => Range;
  /** The skill's own saving for this figure; null when a skill never states one. */
  readonly saved: (benefit: SkillExpectedBenefit) => Range | null;
}

const ROWS: readonly RowSpec[] = [
  {
    key: 'time_to_diagnosis_minutes',
    label: 'Time to diagnosis',
    unit: 'minutes',
    recorded: (metrics) => metrics.timeToDiagnosisMinutes,
    saved: (benefit) => benefit.timeSavedMinutes,
  },
  {
    key: 'time_to_useful_evidence_minutes',
    label: 'Time to useful evidence',
    unit: 'minutes',
    recorded: (metrics) => metrics.timeToUsefulEvidenceMinutes,
    saved: () => null,
  },
  {
    key: 'customer_effort_minutes',
    label: 'Customer effort',
    unit: 'minutes',
    recorded: (metrics) => metrics.customerEffortMinutes,
    saved: (benefit) => benefit.customerEffortSavedMinutes,
  },
  {
    key: 'tokens',
    label: 'Estimated tokens',
    unit: 'tokens',
    recorded: (metrics) => metrics.tokenEstimate,
    saved: (benefit) => benefit.tokensSaved,
  },
];

/** Why there is no recorded figure to set the saving against. */
type NoRecorded = 'no_decision_point' | 'not_whole_record' | 'not_simulated';

const NO_RECORDED_TEXT: Readonly<Record<NoRecorded, string>> = {
  no_decision_point:
    'No decision point of this case relates to the skill, so there is no recorded path to take a figure from.',
  not_whole_record:
    'The recorded path runs past this moment, so its figures are shown only once the whole record is visible.',
  not_simulated:
    'The engine has no simulated figures for this decision point, so there is no recorded figure to take.',
};

const FORMULA =
  'Estimate, not a measurement. With the skill = recorded minus the skill’s own estimated saving, range against range (low = recorded low − saving high, mid = recorded mid − saving mid, high = recorded high − saving low), never below zero.';
const HELD_AT_ZERO =
  ' The skill’s saving is larger than what the case recorded here, so the result is held at zero.';
const SAVING_IS_THE_SKILLS =
  ' The saving shown is the skill’s own estimate from the case it was distilled from.';

interface RowContext {
  readonly metrics: PathMetrics | null;
  readonly noRecorded: NoRecorded | null;
  readonly benefit: SkillExpectedBenefit | undefined;
  readonly applies: boolean;
  /** False when the case already did, at the decision point, what the skill recommends. */
  readonly departs: boolean;
}

function rowOf(spec: RowSpec, row: RowContext): SkillOverlayRow {
  const recorded = row.metrics === null ? null : spec.recorded(row.metrics);
  const saved = row.benefit === undefined ? null : spec.saved(row.benefit);
  const base = { key: spec.key, label: spec.label, unit: spec.unit, recorded, saved };

  const noSaving =
    row.benefit === undefined
      ? 'The skill states no estimated saving, so there is nothing to set against what the case recorded.'
      : 'The skill states no saving for this figure (it estimates time to diagnosis, customer effort and tokens), so no with-skill figure is made.';
  if (recorded === null || row.noRecorded !== null) {
    const missing = NO_RECORDED_TEXT[row.noRecorded ?? 'not_simulated'];
    const basis = saved === null ? `${missing} ${noSaving}` : `${missing}${SAVING_IS_THE_SKILLS}`;
    return { ...base, recorded: null, withSkill: null, basis: clip(basis, 400) };
  }
  if (saved === null) return { ...base, withSkill: null, basis: clip(noSaving, 400) };
  if (!row.applies) {
    return {
      ...base,
      withSkill: null,
      basis: clip(
        `The skill does not apply to this case, so no with-skill figure is made.${SAVING_IS_THE_SKILLS}`,
        400,
      ),
    };
  }
  if (!row.departs) {
    return {
      ...base,
      withSkill: null,
      basis: clip(
        `At the decision point the case already did what the skill recommends, so the skill’s saving does not apply here.${SAVING_IS_THE_SKILLS}`,
        400,
      ),
    };
  }
  const { range, heldAtZero } = subtractSaving(recorded, saved);
  return {
    ...base,
    withSkill: range,
    basis: clip(`${FORMULA}${heldAtZero ? HELD_AT_ZERO : ''}`, 400),
  };
}

const quoted = (text: string): string => `“${clip(text, 100)}”`;

/** What became of the skill's first step in the case, in a sentence. */
function stepSentence(
  step: SkillMatchStep,
  where: { readonly atDecisionPoint: boolean; readonly departs: boolean; readonly whole: boolean },
): string {
  switch (step.status) {
    case 'done':
      return where.atDecisionPoint && where.departs
        ? 'The case did take that step, but at another moment.'
        : 'The case took that step.';
    case 'skipped':
      return 'The case did not take that step: another check had already answered its question.';
    case 'recommended_next':
    case 'pending':
      return where.whole
        ? 'The case never took that step.'
        : 'The case has not taken that step yet.';
  }
}

function recordedNote(input: {
  readonly step: SkillMatchStep | null;
  readonly decisionPoint: DecisionFork | null;
  readonly decisionPointCount: number;
  readonly departs: boolean;
  readonly whole: boolean;
}): string {
  const { step, decisionPoint, departs, whole } = input;
  if (step === null) {
    return 'The skill’s plan names no action to compare with, so no decision point was chosen.';
  }
  const first = `the skill’s first step is ${quoted(step.title)}`;
  if (decisionPoint === null) {
    const none =
      input.decisionPointCount === 0
        ? `The analysis found no decision point in this case, so there is no moment to set the skill’s first step, ${quoted(step.title)}, against.`
        : `None of this case’s decision points had the skill’s first step, ${quoted(step.title)}, open as an alternative.`;
    return clip(`${none} ${stepSentence(step, { atDecisionPoint: false, departs, whole })}`, 600);
  }
  const did = `At this decision point the case did ${quoted(decisionPoint.actual.label)}; ${first}.`;
  return clip(`${did} ${stepSentence(step, { atDecisionPoint: true, departs, whole })}`, 600);
}

const MAX_EVIDENCE = PROVENANCE_MAX_LINKS;

/** The evidence that made the skill match, then the decision point: what `provenance.resolve` can resolve. */
function evidenceOf(
  match: SkillMatch,
  decisionPoint: DecisionFork | null,
): { links: EvidenceLink[]; shown: number; total: number } {
  const room = MAX_EVIDENCE - (decisionPoint === null ? 0 : 1);
  const seen = new Set<string>();
  const all: EvidenceLink[] = [];
  for (const trigger of match.matchedTriggers) {
    for (const id of trigger.evidenceIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      all.push({ type: 'evidence', id, label: clip(trigger.description, 200) });
    }
  }
  const links = all.slice(0, room);
  if (decisionPoint !== null) {
    links.push({ type: 'fork', id: decisionPoint.id, label: clip(decisionPoint.title, 200) });
  }
  return { links, shown: links.length - (decisionPoint === null ? 0 : 1), total: all.length };
}

function assumptionsOf(input: {
  readonly benefit: SkillExpectedBenefit | undefined;
  readonly decisionPoint: DecisionFork | null;
  readonly fromThisCase: boolean;
  readonly content: SkillContent;
}): string[] {
  const { benefit, decisionPoint } = input;
  const items = [
    'Every figure is an estimate computed from the stored analysis and the skill’s own figures. Nothing was run, applied or measured.',
  ];
  if (benefit === undefined) {
    items.push('The skill states no estimated saving.');
  } else {
    items.push(`The skill’s saving is its own estimate: ${benefit.basis}`);
    if (decisionPoint !== null) {
      const origin = input.content.provenance?.forkId ?? null;
      items.push(
        input.fromThisCase && origin === decisionPoint.id
          ? 'This is the case the skill was distilled from and this is its decision point, so the comparison is the skill’s own replay set beside the recorded path.'
          : 'The saving the skill measured on the case it was distilled from is assumed to carry over to this case.',
      );
    }
  }
  return uniq(items.map((item) => clip(item, 400)));
}

function limitationsOf(input: {
  readonly match: SkillMatch;
  readonly content: SkillContent;
  readonly whole: boolean;
  readonly evidence: { shown: number; total: number };
}): string[] {
  const { match, content, whole, evidence } = input;
  const items: string[] = [
    ...(content.applicability?.limitations ?? []),
    ...(content.expectedBenefit?.caveats ?? []),
  ];
  if (!whole) {
    items.push(
      'The path a case takes from a decision point includes events after this moment, so recorded figures are shown only once the whole record is visible.',
    );
  }
  if (match.applicability === 'partial') {
    items.push('The skill matches this case only partly, so the estimate is less certain.');
  }
  if (match.applicability === 'not_applicable') {
    items.push(
      'The skill does not apply to this case: a required trigger is unmet or an exclusion holds.',
    );
  }
  if (match.lifecycle === 'deprecated' || match.lifecycle === 'retired') {
    items.push(`This skill is ${match.lifecycle} and is no longer offered to other cases.`);
  }
  if (evidence.total > evidence.shown) {
    items.push(
      `Showing ${evidence.shown} of ${evidence.total} pieces of evidence that made the skill match.`,
    );
  }
  items.push('This comparison applies nothing: adopting the plan is a separate, audited step.');
  return uniq(items.map((item) => clip(item, 400)));
}

/**
 * The overlay for one match. Pure: the same inputs give the same overlay, and the figures of a case whose
 * record is not whole are never part of it, whatever the caller passes (see the rules at the top).
 */
export function buildSkillOverlay(input: SkillOverlayInput): SkillOverlay {
  const { match, content, decisionPoint, recorded } = input;
  const step = firstRecommendedStep(match);
  const applies = match.applicability !== 'not_applicable';
  const departs =
    decisionPoint !== null && step !== null && decisionPoint.actual.actionKey !== step.actionKey;

  const noRecorded: NoRecorded | null =
    decisionPoint === null
      ? 'no_decision_point'
      : !recorded.wholeRecord
        ? 'not_whole_record'
        : recorded.metrics === null
          ? 'not_simulated'
          : null;
  const metrics = noRecorded === null ? recorded.metrics : null;
  const benefit = content.expectedBenefit;
  const fromThisCase =
    content.provenance?.caseId === input.caseId ||
    content.sourceCases.some(
      (source) => source.role === 'origin' && source.caseId === input.caseId,
    );
  const evidence = evidenceOf(match, decisionPoint);

  const actualKey = decisionPoint?.actual.actionKey ?? null;
  const cheaper =
    applies && actualKey !== null
      ? (content.cheaperAlternatives?.find((item) => item.insteadOfActionKey === actualKey) ?? null)
      : null;

  return {
    caseId: input.caseId,
    matchId: match.id,
    asOf: match.asOf,
    skill: {
      id: match.skillId,
      versionId: match.versionId,
      name: clip(match.skillName, 160),
      version: match.skillVersion,
      lifecycle: match.lifecycle,
    },
    score: match.score,
    applicability: match.applicability,
    applied: match.applied,
    decisionPoint:
      decisionPoint === null
        ? null
        : {
            forkId: decisionPoint.id,
            eventId: decisionPoint.eventId,
            at: decisionPoint.timestamp,
            title: clip(decisionPoint.title, 300),
            summary: clip(decisionPoint.summary, 800),
          },
    recorded: {
      actionKey: decisionPoint?.actual.actionKey ?? null,
      actionLabel: decisionPoint === null ? null : clip(decisionPoint.actual.label, 300),
      followedRecommendedStep: step?.status === 'done',
      note: recordedNote({
        step,
        decisionPoint,
        decisionPointCount: input.decisionPointCount,
        departs,
        whole: recorded.wholeRecord,
      }),
    },
    withSkill: { steps: match.recommendedSteps, cheaperAlternative: cheaper },
    comparison: ROWS.map((spec) => rowOf(spec, { metrics, noRecorded, benefit, applies, departs })),
    evidence: evidence.links,
    assumptions: assumptionsOf({ benefit, decisionPoint, fromThisCase, content }),
    limitations: limitationsOf({ match, content, whole: recorded.wholeRecord, evidence }),
    labels: { estimated: true, simulated: true, recordedAnalysisUnchanged: true },
  };
}
