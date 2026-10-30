import type { ActionValueConfig, AgentName, CounterfactualStrategy } from '@caseguard/schemas';
import { createTemporalView, generateCounterfactuals, type TemporalView } from '@caseguard/domain';
import {
  counterfactualTask,
  runDeterministicTask,
  type AgentOutputs,
  type AgentTask,
  type AgentTaskOf,
  type TaskBase,
} from '../src';
import { CONFIG, TENANT, eventBySuffix, type Prepared } from './helpers';

/** Pre-resolution window ending at the event with the given id suffix (inclusive). */
export function viewUpTo(p: Prepared, suffix: string): TemporalView {
  return createTemporalView(p.normalized.events, eventBySuffix(p, suffix).timestamp);
}

/** Whole record without the resolution object (still a pre-resolution task window). */
export function wholeRecordView(p: Prepared): TemporalView {
  const events = p.normalized.events;
  const last = events[events.length - 1];
  if (!last) throw new Error('empty case');
  return createTemporalView(events, last.timestamp);
}

export function baseOf(p: Prepared, view: TemporalView, hindsight = true): TaskBase {
  return {
    tenantId: TENANT,
    caseId: p.ctx.caseId,
    analysisRunId: p.ctx.runId,
    view,
    pack: p.pack,
    config: CONFIG,
    ctx: p.ctx,
    analysis: p.analysis,
    hindsight: hindsight
      ? { events: p.normalized.events, resolution: p.normalized.resolution }
      : undefined,
  };
}

export const timelineTask = (
  p: Prepared,
  view = wholeRecordView(p),
): AgentTaskOf<'timeline_analyzer'> => ({
  agent: 'timeline_analyzer',
  input: baseOf(p, view),
});

export const classifierTask = (
  p: Prepared,
  view = wholeRecordView(p),
): AgentTaskOf<'evidence_classifier'> => ({
  agent: 'evidence_classifier',
  input: baseOf(p, view),
});

export const hypothesisTask = (
  p: Prepared,
  view = wholeRecordView(p),
): AgentTaskOf<'hypothesis_generator'> => ({
  agent: 'hypothesis_generator',
  input: baseOf(p, view),
});

export const forkTask = (
  p: Prepared,
  view = wholeRecordView(p),
): AgentTaskOf<'decision_fork_detector'> => ({
  agent: 'decision_fork_detector',
  input: baseOf(p, view),
});

export const qualityTask = (p: Prepared): AgentTaskOf<'quality_judge'> => ({
  agent: 'quality_judge',
  input: baseOf(p, p.view, false),
});

export const coachTask = (p: Prepared): AgentTaskOf<'communication_coach'> => ({
  agent: 'communication_coach',
  input: baseOf(p, p.view, false),
});

export function cfTask(
  p: Prepared,
  forkSuffix: string,
  strategy: CounterfactualStrategy = 'balanced',
  rolloutCount = 40,
  config: ActionValueConfig = CONFIG,
): AgentTaskOf<'counterfactual_simulator'> {
  const fork = p.analysis.forks.find((f) => f.eventId === eventBySuffix(p, forkSuffix).id);
  if (!fork) throw new Error(`no fork at ${forkSuffix}`);
  return counterfactualTask({
    tenantId: TENANT,
    caseId: p.ctx.caseId,
    analysisRunId: p.ctx.runId,
    analysis: p.analysis,
    fork,
    strategy,
    events: p.normalized.events,
    resolution: p.normalized.resolution,
    pack: p.pack,
    config,
    ctx: p.ctx,
    rolloutCount,
  });
}

export function skillTask(
  p: Prepared,
  forkSuffix: string,
  strategy: CounterfactualStrategy = 'balanced',
): AgentTaskOf<'skilldna_extractor'> {
  const fork = p.analysis.forks.find((f) => f.eventId === eventBySuffix(p, forkSuffix).id);
  if (!fork) throw new Error(`no fork at ${forkSuffix}`);
  const scenario = generateCounterfactuals({
    analysis: p.analysis,
    fork,
    strategies: [strategy],
    events: p.normalized.events,
    resolution: p.normalized.resolution,
    pack: p.pack,
    config: CONFIG,
    ctx: p.ctx,
    rolloutCount: 40,
  }).scenarios[0];
  if (!scenario) throw new Error('no scenario');
  return { agent: 'skilldna_extractor', input: { ...baseOf(p, p.view, false), fork, scenario } };
}

/** The deterministic (reference) output for a task, as a mutable deep copy. */
export function validOutput<A extends AgentName>(task: AgentTaskOf<A>): AgentOutputs[A] {
  return structuredClone(runDeterministicTask(task));
}

export type { AgentTask };
