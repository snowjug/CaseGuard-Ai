import type { ActionValueConfig, SkillMatch, SkillVersion } from '@caseguard/schemas';
import { resolveActionKey } from '../engine/actions';
import type { CompiledPack } from '../knowledge/compile';
import { round } from '../util/math';
import { formatUtcStamp } from '../util/time';
import { asOfView, type AnalysisAsOf } from './guidance';
import { planFromState, type GuidedPlanStep } from './plan';
import { knowledgeStateFromView } from './state';

export type ConformanceStatus =
  | 'followed'
  | 'followed_alternative'
  | 'not_needed'
  | 'skipped'
  | 'different_route'
  | 'not_reached';

export interface ConformanceStage {
  stage: number;
  title: string;
  status: ConformanceStatus;
  actionKey: string | null;
  eventId: string | null;
  at: string | null;
  timing: 'before_application' | 'after_application' | null;
  /** Plain-language, non-judgemental explanation. */
  reason: string;
}

export interface OutsideSkillAction {
  eventId: string;
  at: string;
  actionKey: string;
  label: string;
  note: string;
}

export interface ConformanceReport {
  versionId: string;
  throughAt: string;
  stagesTotal: number;
  stagesFollowed: number;
  /** Stages that still mattered (not made unnecessary, and reached). */
  stagesApplicable: number;
  score: number;
  level: 'high' | 'moderate' | 'low';
  label: string;
  stages: ConformanceStage[];
  /** Steps taken that the skill does not list (diagnostic detours, remediation, validation...). */
  outsideSkill: OutsideSkillAction[];
  inStageOrder: boolean;
  summary: string;
  notices: string[];
}

export const CONFORMANCE_HIGH = 0.75;
export const CONFORMANCE_MODERATE = 0.5;

const LEVEL_LABEL: Record<ConformanceReport['level'], string> = {
  high: 'Closely aligned with the skill',
  moderate: 'Partly aligned with the skill',
  low: 'Mostly a different route from the skill',
};

export interface ConformanceInput {
  version: SkillVersion;
  /** Only events at or before `throughAt` are read. */
  analysis: AnalysisAsOf;
  pack: CompiledPack;
  config: ActionValueConfig;
  caseId: string;
  /** When the skill was applied; steps taken earlier are reported as taken before the application. */
  appliedAt: string | null;
  throughAt: string;
}

const NON_DIAGNOSTIC = new Set(['remediation', 'validation', 'communication']);

/**
 * Compares the recorded steps with the skill, stage by stage: followed, followed through an alternative
 * the skill lists, made unnecessary by earlier evidence, or a different route. The wording describes
 * the route taken for learning; it never rates the engineer.
 */
export function checkConformance(input: ConformanceInput): ConformanceReport {
  const { version, analysis, pack, config, caseId, appliedAt, throughAt } = input;
  const view = asOfView(analysis, throughAt);
  const { state } = knowledgeStateFromView(view, pack, caseId);
  const core = planFromState({ content: version.content, pack, config, state });
  const skillKeys = new Set(
    core.steps.map((s) => s.actionKey).filter((k): k is string => k !== null),
  );

  const taken = view.events.flatMap((event) => {
    const key = resolveActionKey(event, pack);
    return key ? [{ event, key }] : [];
  });
  const outsideSkill: OutsideSkillAction[] = taken
    .filter(({ key }) => !skillKeys.has(key))
    .map(({ event, key }) => {
      const action = pack.actions.get(key);
      return {
        eventId: event.id,
        at: event.timestamp,
        actionKey: key,
        label: action?.label ?? key,
        note:
          action && NON_DIAGNOSTIC.has(action.valueClass)
            ? 'After the diagnosis or outside the skill’s scope: not assessed.'
            : 'A different route from the skill’s steps; recorded for learning.',
      };
    });
  const detours = outsideSkill.filter((o) => {
    const action = pack.actions.get(o.actionKey);
    return !(action && NON_DIAGNOSTIC.has(action.valueClass));
  });

  const stageNumbers = [...new Set(core.steps.map((s) => s.stage))].sort((a, b) => a - b);
  const stageSteps = (stage: number): GuidedPlanStep[] =>
    core.steps.filter((s) => s.stage === stage);
  // When each stage was settled: the time of its step, or '' when earlier evidence made it unnecessary.
  const settledAt = new Map<number, string>();
  for (const stage of stageNumbers) {
    const group = stageSteps(stage);
    const times = group.flatMap((s) =>
      s.status === 'done' && s.executedAt !== null ? [s.executedAt] : [],
    );
    if (times.length > 0) settledAt.set(stage, [...times].sort()[0] ?? '');
    else if (group.some((s) => s.status === 'skipped')) settledAt.set(stage, '');
  }
  const lastTakenStage = Math.max(
    0,
    ...stageNumbers.filter((n) => stageSteps(n).some((s) => s.status === 'done')),
  );
  // A detour belongs to the first stage that was still open when it happened.
  const detoursByStage = new Map<number, OutsideSkillAction[]>();
  for (const detour of detours) {
    const owner = stageNumbers.find((n) => {
      const settled = settledAt.get(n);
      return settled === undefined || settled > detour.at;
    });
    if (owner !== undefined)
      detoursByStage.set(owner, [...(detoursByStage.get(owner) ?? []), detour]);
  }
  const ended = core.status !== 'in_progress';
  const blank = { actionKey: null, eventId: null, at: null, timing: null } as const;
  const stages: ConformanceStage[] = stageNumbers.map((stage) => {
    const group = stageSteps(stage);
    const done = group.find((s) => s.status === 'done');
    const title =
      group.find((s) => s.role === 'skill_step')?.title ?? group[0]?.title ?? `Stage ${stage}`;
    const timing = (s: GuidedPlanStep): ConformanceStage['timing'] =>
      s.executedAt === null
        ? null
        : appliedAt !== null && s.executedAt < appliedAt
          ? 'before_application'
          : 'after_application';
    if (done) {
      const alternative = done.role === 'stage_alternative' || done.title !== title;
      return {
        stage,
        title,
        status: alternative ? 'followed_alternative' : 'followed',
        actionKey: done.actionKey,
        eventId: done.executedEventId,
        at: done.executedAt,
        timing: timing(done),
        reason: alternative
          ? `Taken at ${done.executedAt ? formatUtcStamp(done.executedAt) : 'an earlier time'} using the alternative “${done.title}”, which answers the same question as “${title}”.`
          : `Taken at ${done.executedAt ? formatUtcStamp(done.executedAt) : 'an earlier time'}: ${done.title}.`,
      };
    }
    const unnecessary = group.find((s) => s.status === 'skipped');
    if (unnecessary) {
      return {
        stage,
        title,
        ...blank,
        actionKey: unnecessary.actionKey,
        status: 'not_needed',
        reason: `No separate step was needed: ${unnecessary.rationale.replace(/^Not needed: /, '')}`,
      };
    }
    const here = detoursByStage.get(stage) ?? [];
    if (here.length > 0) {
      return {
        stage,
        title,
        ...blank,
        status: 'different_route',
        reason: `A different route was taken here (${[...new Set(here.map((d) => d.label))].slice(0, 3).join('; ')}). It is recorded for learning, and the skill may need a branch for it.`,
      };
    }
    if (stage < lastTakenStage) {
      return {
        stage,
        title,
        ...blank,
        status: 'skipped',
        reason:
          'No separate step was recorded for this stage before later stages were taken; the evidence it provides may have been gathered another way.',
      };
    }
    return {
      stage,
      title,
      ...blank,
      status: 'not_reached',
      reason: ended
        ? 'The path ended at an earlier stage, so this stage was not needed.'
        : 'No step has been taken at this stage yet.',
    };
  });

  const followed = stages.filter(
    (s) => s.status === 'followed' || s.status === 'followed_alternative',
  ).length;
  const applicable = stages.filter(
    (s) => s.status !== 'not_needed' && s.status !== 'not_reached',
  ).length;
  const score = applicable === 0 ? 0 : round(followed / applicable, 3);
  const level: ConformanceReport['level'] =
    score >= CONFORMANCE_HIGH ? 'high' : score >= CONFORMANCE_MODERATE ? 'moderate' : 'low';
  const dated = stages.filter((s) => s.at !== null).map((s) => s.at as string);
  const inStageOrder = dated.every((at, i) => i === 0 || (dated[i - 1] ?? '') <= at);
  const alternatives = stages.filter((s) => s.status === 'followed_alternative').length;
  const skippedCount = stages.filter((s) => s.status === 'skipped').length;
  const differentCount = stages.filter((s) => s.status === 'different_route').length;
  const summary =
    applicable === 0
      ? 'No stage of the skill has been reached yet, so there is nothing to compare.'
      : `${LEVEL_LABEL[level]}: ${followed} of ${applicable} applicable stages were taken${alternatives > 0 ? `, ${alternatives} through an alternative check the skill lists` : ''}${skippedCount > 0 ? `; ${skippedCount} had no recorded step` : ''}${differentCount > 0 ? `; ${differentCount} took a different route` : ''}${inStageOrder ? '' : '; some stages were taken in a different order'}.${detours.length > 0 ? ` ${detours.length} other step${detours.length === 1 ? ' was' : 's were'} taken outside the skill, which can show where the skill needs a new branch.` : ''}`;
  return {
    versionId: version.id,
    throughAt,
    stagesTotal: stages.length,
    stagesFollowed: followed,
    stagesApplicable: applicable,
    score,
    level,
    label: LEVEL_LABEL[level],
    stages,
    outsideSkill,
    inStageOrder,
    summary,
    notices: [
      'Conformance describes how closely the recorded steps match the skill. It supports learning and improving the skill; it does not rate people.',
      'A different route is often right when the evidence points elsewhere.',
    ],
  };
}

/** Projection stored on a SkillMatch once the skill has been applied. */
export function toMatchConformance(
  report: ConformanceReport,
): NonNullable<SkillMatch['conformance']> {
  return {
    stepsFollowed: report.stagesFollowed,
    stepsTotal: report.stagesTotal,
    score: report.score,
  };
}
