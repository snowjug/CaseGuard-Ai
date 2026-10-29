import type {
  CaseEvent,
  CaseResolution,
  Range,
  SkillDna,
  SkillMatch,
  SkillValidation,
  SkillVersion,
} from '@caseguard/schemas';
import type { ActionValueConfig } from '@caseguard/schemas';
import type { EngineContext } from '../engine/context';
import { resolutionHypothesisKey } from '../engine/hindsight';
import type { DeterministicAnalysis } from '../engine/pipeline';
import { createTemporalViewBeforeEvent } from '../engine/temporal';
import type { CompiledPack } from '../knowledge/compile';
import { round } from '../util/math';
import { formatDuration } from '../util/time';
import { defaultDecisionEventId, measureActualPath, type ActualMeasure } from './actual';
import { buildEvidenceIndex, type CaseInfo } from './evidence';
import { applicabilityOf, scoreConditions } from './matching';
import { replaySkillPath, type SkillReplayResult } from './replay';
import { knowledgeStateFromView } from './state';
import type { SkillOpContext } from './types';

/** A prior case a skill can be replayed on. `analysis` is the full, post-hoc analysis of that case. */
export interface SkillReplayCase {
  caseId: string;
  reference: string;
  synthetic: boolean;
  caseInfo: CaseInfo;
  events: readonly CaseEvent[];
  resolution: CaseResolution | null;
  analysis: DeterministicAnalysis;
  pack: CompiledPack;
  config: ActionValueConfig;
  ctx: EngineContext;
  /** Defaults to the earliest eligible fork, else the first action of the case. */
  decisionEventId?: string;
}

export type ReplayExpectation = 'improves' | 'non_breaking' | 'not_applicable';
export type ReplayVerdict =
  | 'improves'
  | 'equivalent'
  | 'slower'
  | 'safe_stop'
  | 'breaking'
  | 'not_applicable'
  | 'no_decision_point';

export interface ReplayCaseInput {
  replayCase: SkillReplayCase;
  expectation: ReplayExpectation;
}

export interface SkillCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface SkillCaseReport {
  caseId: string;
  reference: string;
  synthetic: boolean;
  decisionEventId: string | null;
  decisionAt: string | null;
  expectation: ReplayExpectation;
  verdict: ReplayVerdict;
  match: {
    applicability: SkillMatch['applicability'];
    score: number;
    metTriggerIds: string[];
    unmetTriggerIds: string[];
    exclusionIds: string[];
  } | null;
  replay: SkillReplayResult | null;
  actual: ActualMeasure | null;
  comparison: {
    timeToDiagnosisMinutes: { actual: number; skill: Range };
    customerEffortMinutes: { actual: number; skill: number };
    evidenceCompleteness: { actual: number; skill: number };
  } | null;
  checks: SkillCheck[];
  passed: boolean;
  /** The replay answers step outcomes from the recorded resolution: hindsight, labelled as such. */
  usedFinalResolution: boolean;
}

export interface SkillSimulationReport {
  kind: 'simulation_test' | 'regression';
  skillId: string;
  versionId: string;
  skillVersion: string;
  outcome: 'passed' | 'failed' | 'inconclusive';
  cases: SkillCaseReport[];
  notices: string[];
}

const timeTolerance = (actual: number): number => Math.max(30, actual * 0.25);
const effortTolerance = (actual: number): number => Math.max(20, actual * 0.25);

function verdictOf(replay: SkillReplayResult, actual: ActualMeasure | null): ReplayVerdict {
  if (
    replay.metrics.unsafeSteps > 0 ||
    replay.falseDiagnosis ||
    (replay.terminal === 'success' && !replay.reachedDiagnosis)
  ) {
    return 'breaking';
  }
  if (!replay.reachedDiagnosis) return 'safe_stop';
  if (!actual) return 'equivalent';
  const time = replay.metrics.timeToDiagnosisMinutes.mid;
  const effort = replay.metrics.customerEffortMinutes;
  if (time < actual.timeToDiagnosisMinutes && effort <= actual.customerEffortMinutes)
    return 'improves';
  if (
    time <= actual.timeToDiagnosisMinutes + timeTolerance(actual.timeToDiagnosisMinutes) &&
    effort <= actual.customerEffortMinutes + effortTolerance(actual.customerEffortMinutes)
  ) {
    return 'equivalent';
  }
  return 'slower';
}

const PASSING: Record<ReplayExpectation, readonly ReplayVerdict[]> = {
  improves: ['improves'],
  non_breaking: ['improves', 'equivalent', 'safe_stop'],
  not_applicable: ['not_applicable'],
};

/** Replays one skill version on one prior case at its decision point, using only pre-decision information. */
export function evaluateReplayCase(
  skill: Pick<SkillDna, 'workload'>,
  version: SkillVersion,
  input: ReplayCaseInput,
): SkillCaseReport {
  const { replayCase: c, expectation } = input;
  const base = {
    caseId: c.caseId,
    reference: c.reference,
    synthetic: c.synthetic,
    expectation,
    usedFinalResolution: false,
  };
  const decisionEventId = c.decisionEventId ?? defaultDecisionEventId(c.analysis);
  if (!decisionEventId) {
    return {
      ...base,
      decisionEventId: null,
      decisionAt: null,
      verdict: 'no_decision_point',
      match: null,
      replay: null,
      actual: null,
      comparison: null,
      checks: [
        {
          id: 'decision-point',
          passed: false,
          detail: 'The case has no decision point to replay from.',
        },
      ],
      passed: false,
    };
  }
  const preView = createTemporalViewBeforeEvent(c.events, decisionEventId);
  const { state: state0, analysis: pre } = knowledgeStateFromView(preView, c.pack, c.ctx.caseId);
  const index = buildEvidenceIndex(pre, c.caseInfo);
  const content = version.content;
  const sameWorkload = skill.workload === c.caseInfo.workload;
  const score = sameWorkload
    ? scoreConditions(content.triggerConditions, content.exclusions, index)
    : {
        matched: [],
        unmatched: [...content.triggerConditions],
        requiredUnmet: [],
        exclusionsHit: [],
        coverage: 0,
      };
  const result = sameWorkload
    ? applicabilityOf(score)
    : { applicability: 'not_applicable' as const, score: 0 };
  const decisionEvent = c.events.find((e) => e.id === decisionEventId);
  const checks: SkillCheck[] = [
    {
      id: 'temporal-integrity',
      passed:
        preView.resolution === null &&
        preView.events.every(
          (e) => decisionEvent !== undefined && e.timestamp <= decisionEvent.timestamp,
        ),
      detail: `Matching and replay used ${preView.events.length} events recorded before the decision and never the final resolution.`,
    },
  ];
  const match = {
    applicability: result.applicability,
    score: result.score,
    metTriggerIds: score.matched.map((m) => m.condition.id),
    unmetTriggerIds: score.unmatched.map((u) => u.id),
    exclusionIds: score.exclusionsHit.map((e) => e.id),
  };
  const matched = result.applicability !== 'not_applicable';
  if (expectation === 'not_applicable') {
    checks.push({
      id: 'does-not-match',
      passed: !matched,
      detail: matched
        ? `The skill matched this case (${result.applicability}, score ${round(result.score * 100, 0)}%) although it should not.`
        : `The skill correctly does not apply${match.exclusionIds.length > 0 ? ` (exclusion hit: ${match.exclusionIds.join(', ')})` : ''}.`,
    });
  } else {
    checks.push({
      id: 'matches-at-decision',
      passed: matched,
      detail: matched
        ? `The skill ${result.applicability === 'applies' ? 'applies' : 'partially applies'} with only the evidence available at the decision (score ${round(result.score * 100, 0)}%).`
        : 'The skill did not match with the evidence available at the decision.',
    });
  }
  if (!matched) {
    const verdict: ReplayVerdict = 'not_applicable';
    return {
      ...base,
      decisionEventId,
      decisionAt: decisionEvent?.timestamp ?? null,
      verdict,
      match,
      replay: null,
      actual: null,
      comparison: null,
      checks,
      passed: checks.every((x) => x.passed),
    };
  }

  const truth = resolutionHypothesisKey(c.resolution, c.pack);
  const minimumEvidence = content.minimumEvidence.map((m) => m.requirementId);
  const replay = replaySkillPath({
    content,
    pack: c.pack,
    config: c.config,
    state0,
    truthHypothesis: truth,
    minimumEvidence,
  });
  const fromIndex = c.analysis.view.events.findIndex((e) => e.id === decisionEventId);
  const actual =
    decisionEvent && fromIndex >= 0
      ? measureActualPath({
          analysis: c.analysis,
          pack: c.pack,
          fromIndex,
          fromAt: decisionEvent.timestamp,
          minimumEvidence,
        })
      : null;
  const verdict = verdictOf(replay, actual);
  checks.push(
    {
      id: 'safe-steps',
      passed: replay.metrics.unsafeSteps === 0,
      detail:
        replay.metrics.unsafeSteps === 0
          ? 'Every replayed step is read-only, non-destructive and within the risk ceiling.'
          : `${replay.metrics.unsafeSteps} replayed step(s) were unsafe.`,
    },
    {
      id: 'no-false-diagnosis',
      passed: !replay.falseDiagnosis,
      detail: replay.falseDiagnosis
        ? 'The replay ended confident in a cause other than the recorded one.'
        : 'The replay never reports a diagnosis that contradicts the recorded cause.',
    },
  );
  const simulated = `${formatDuration(replay.metrics.timeToDiagnosisMinutes.mid)} (range ${formatDuration(replay.metrics.timeToDiagnosisMinutes.low)}–${formatDuration(replay.metrics.timeToDiagnosisMinutes.high)})`;
  if (expectation === 'improves') {
    checks.push(
      {
        id: 'reaches-diagnosis',
        passed: replay.reachedDiagnosis,
        detail: replay.reachedDiagnosis
          ? 'The guided path reaches a confirmed diagnosis.'
          : `The guided path ended without a confirmed diagnosis (${replay.terminal}).`,
      },
      {
        id: 'sooner-than-recorded',
        passed:
          actual !== null &&
          replay.reachedDiagnosis &&
          replay.metrics.timeToDiagnosisMinutes.mid < actual.timeToDiagnosisMinutes,
        detail: actual
          ? `Estimated ${simulated} versus ${formatDuration(actual.timeToDiagnosisMinutes)} recorded (simulated estimate, outcomes from the recorded cause).`
          : 'The recorded path could not be measured.',
      },
      {
        id: 'no-more-customer-effort',
        passed:
          actual !== null && replay.metrics.customerEffortMinutes <= actual.customerEffortMinutes,
        detail: actual
          ? `Estimated ${replay.metrics.customerEffortMinutes} customer minutes versus ${actual.customerEffortMinutes} recorded.`
          : 'The recorded path could not be measured.',
      },
    );
  } else {
    checks.push({
      id: 'non-breaking',
      passed: PASSING.non_breaking.includes(verdict),
      detail: `Verdict ${verdict}: ${replay.reachedDiagnosis ? `reaches the recorded diagnosis in an estimated ${simulated}${actual ? ` versus ${formatDuration(actual.timeToDiagnosisMinutes)} recorded` : ''}` : `stops at a declared stop condition (${replay.terminal}) without a false diagnosis`}.`,
    });
  }
  return {
    ...base,
    usedFinalResolution: replay.usedFinalResolution,
    decisionEventId,
    decisionAt: decisionEvent?.timestamp ?? null,
    verdict,
    match,
    replay,
    actual,
    comparison: actual
      ? {
          timeToDiagnosisMinutes: {
            actual: actual.timeToDiagnosisMinutes,
            skill: replay.metrics.timeToDiagnosisMinutes,
          },
          customerEffortMinutes: {
            actual: actual.customerEffortMinutes,
            skill: replay.metrics.customerEffortMinutes,
          },
          evidenceCompleteness: {
            actual: actual.evidenceCompleteness,
            skill: replay.metrics.evidenceCompleteness,
          },
        }
      : null,
    checks,
    passed: checks.every((x) => x.passed) && PASSING[expectation].includes(verdict),
  };
}

const NOTICES = [
  'Simulated replay: nothing was executed. Step outcomes come from the recorded root cause of each case (hindsight), and only for steps the skill itself chose using information available at the decision point.',
  'Time, effort and token figures are model estimates, not measurements.',
];

function reportOf(
  kind: SkillSimulationReport['kind'],
  skill: SkillDna,
  version: SkillVersion,
  cases: SkillCaseReport[],
): SkillSimulationReport {
  const outcome: SkillSimulationReport['outcome'] =
    cases.length === 0 || cases.some((c) => c.verdict === 'no_decision_point')
      ? 'inconclusive'
      : cases.every((c) => c.passed)
        ? 'passed'
        : 'failed';
  return {
    kind,
    skillId: skill.id,
    versionId: version.id,
    skillVersion: version.version,
    outcome,
    cases,
    notices: NOTICES,
  };
}

/**
 * Replays a skill version on the cases it was derived from, at their decision points. The origin case
 * must show an improvement: the guided path reaches the recorded diagnosis sooner with no more
 * estimated customer effort. Other source cases (a mutation source, a validation case) only have to
 * stay non-breaking, because an efficient case leaves little room to improve. Steps must be safe and
 * the replay must never report a false diagnosis.
 */
export function runSkillSimulationTest(input: {
  skill: SkillDna;
  version: SkillVersion;
  cases: readonly SkillReplayCase[];
}): SkillSimulationReport {
  const { skill, version } = input;
  const roleOf = (caseId: string) =>
    version.content.sourceCases.find((s) => s.caseId === caseId)?.role;
  return reportOf(
    'simulation_test',
    skill,
    version,
    input.cases.map((replayCase) =>
      evaluateReplayCase(skill, version, {
        replayCase,
        expectation: roleOf(replayCase.caseId) === 'origin' ? 'improves' : 'non_breaking',
      }),
    ),
  );
}

/**
 * Regression suite: each case carries what the skill must do there. A related case must not be made
 * worse or misled; an irrelevant case must not match at all.
 */
export function runSkillRegressionSuite(input: {
  skill: SkillDna;
  version: SkillVersion;
  cases: readonly ReplayCaseInput[];
}): SkillSimulationReport {
  const { skill, version } = input;
  return reportOf(
    'regression',
    skill,
    version,
    input.cases.map((c) => evaluateReplayCase(skill, version, c)),
  );
}

/** The persistable validation record for a report. */
export function toSkillValidation(args: {
  report: SkillSimulationReport;
  op: SkillOpContext;
  executedBy: string;
}): SkillValidation {
  const { report, op, executedBy } = args;
  const only = report.cases.length === 1 ? report.cases[0] : undefined;
  return {
    tenantId: op.tenantId,
    createdAt: op.now,
    updatedAt: op.now,
    createdBy: executedBy,
    version: 1,
    id: op.nextId('skval'),
    skillId: report.skillId,
    versionId: report.versionId,
    kind: report.kind,
    outcome: report.outcome,
    caseId: only?.caseId ?? null,
    checks: report.cases.flatMap((c) =>
      c.checks.map((check) => ({
        id: `${c.reference}:${check.id}`,
        passed: check.passed,
        detail: check.detail,
      })),
    ),
    executedBy,
    executedAt: op.now,
    synthetic: report.cases.length > 0 && report.cases.every((c) => c.synthetic),
  };
}
