import type { CounterfactualStrategy } from '@caseguard/schemas';
import {
  createTemporalView,
  generateCounterfactuals,
  runDeterministicAnalysis,
} from '@caseguard/domain';
import { counterfactualTask } from '../agents/builders';
import type { AgentTask, TaskBase } from '../agents/tasks';
import type { EvalCase } from './types';

export interface PlannedSample {
  caseId: string;
  label: string;
  task: AgentTask;
}

export interface PlanOptions {
  /** Fractions of the record at which as-of (pre-resolution) windows end. */
  cutFractions?: readonly number[];
  maxForks?: number;
  strategies?: readonly CounterfactualStrategy[];
  /** Smaller than the product default to keep evaluation fast; results stay reproducible. */
  rolloutCount?: number;
}

const DEFAULTS = {
  cutFractions: [0.25, 0.5, 0.75, 1],
  maxForks: 3,
  strategies: ['balanced'] as CounterfactualStrategy[],
  rolloutCount: 60,
};

/**
 * Chooses the evaluation samples for one case: pre-resolution windows at several cut points (as
 * the API replays them), the fork detector on the longest and a middle window, counterfactuals at
 * a few real forks, and the post-hoc agents on the whole record.
 */
export function planSamples(evalCase: EvalCase, options: PlanOptions = {}): PlannedSample[] {
  const fractions = options.cutFractions ?? DEFAULTS.cutFractions;
  const maxForks = options.maxForks ?? DEFAULTS.maxForks;
  const strategies = options.strategies ?? DEFAULTS.strategies;
  const rolloutCount = options.rolloutCount ?? DEFAULTS.rolloutCount;
  const { events, pack, config, ctx, tenantId } = evalCase;
  const samples: PlannedSample[] = [];
  const baseOf = (
    view: TaskBase['view'],
    analysis: TaskBase['analysis'],
    hindsight: boolean,
  ): TaskBase => ({
    tenantId,
    caseId: ctx.caseId,
    analysisRunId: ctx.runId,
    view,
    pack,
    config,
    ctx,
    analysis,
    hindsight: hindsight ? { events, resolution: evalCase.resolution } : undefined,
  });

  const cutIndexes = [
    ...new Set(
      fractions.map((f) =>
        Math.min(events.length - 1, Math.max(0, Math.ceil(f * events.length) - 1)),
      ),
    ),
  ];
  cutIndexes.forEach((index, position) => {
    const cut = events[index];
    if (!cut) return;
    const view = createTemporalView(events, cut.timestamp);
    const analysis = runDeterministicAnalysis({ view, pack, config, ctx });
    const base = baseOf(view, analysis, true);
    const label = `as of ${cut.id}`;
    samples.push(
      { caseId: evalCase.id, label, task: { agent: 'timeline_analyzer', input: base } },
      { caseId: evalCase.id, label, task: { agent: 'evidence_classifier', input: base } },
      { caseId: evalCase.id, label, task: { agent: 'hypothesis_generator', input: base } },
    );
    if (position === Math.floor(cutIndexes.length / 2) || position === cutIndexes.length - 1) {
      samples.push({
        caseId: evalCase.id,
        label,
        task: { agent: 'decision_fork_detector', input: base },
      });
    }
  });

  const forks = [...evalCase.analysis.forks].sort(
    (a, b) =>
      Number(b.isEarliestMeaningful) - Number(a.isEarliestMeaningful) || a.sequence - b.sequence,
  );
  const stride = Math.max(1, Math.floor(forks.length / maxForks));
  const chosen = forks.filter((_, i) => i % stride === 0).slice(0, maxForks);
  for (const fork of chosen) {
    for (const strategy of strategies) {
      samples.push({
        caseId: evalCase.id,
        label: `fork ${fork.eventId} (${strategy})`,
        task: counterfactualTask({
          tenantId,
          caseId: ctx.caseId,
          analysisRunId: ctx.runId,
          analysis: evalCase.analysis,
          fork,
          strategy,
          events,
          resolution: evalCase.resolution,
          pack,
          config,
          ctx,
          rolloutCount,
        }),
      });
    }
  }

  const postHoc = baseOf(evalCase.view, evalCase.analysis, false);
  samples.push(
    {
      caseId: evalCase.id,
      label: 'whole record',
      task: { agent: 'quality_judge', input: postHoc },
    },
    {
      caseId: evalCase.id,
      label: 'whole record',
      task: { agent: 'communication_coach', input: postHoc },
    },
  );
  const first = chosen[0];
  if (first) {
    const scenario = generateCounterfactuals({
      analysis: evalCase.analysis,
      fork: first,
      strategies: [strategies[0] ?? 'balanced'],
      events,
      resolution: evalCase.resolution,
      pack,
      config,
      ctx,
      rolloutCount,
    }).scenarios[0];
    if (scenario) {
      samples.push({
        caseId: evalCase.id,
        label: `scenario at ${first.eventId}`,
        task: { agent: 'skilldna_extractor', input: { ...postHoc, fork: first, scenario } },
      });
    }
  }
  return samples;
}
