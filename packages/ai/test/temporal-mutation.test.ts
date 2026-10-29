import { describe, expect, it } from 'vitest';
import type { CaseEvent, CaseResolution } from '@caseguard/schemas';
import { DEFAULT_MODEL_CONFIG } from '@caseguard/schemas';
import { createFullView, createTemporalView, runDeterministicAnalysis } from '@caseguard/domain';
import { AiOrchestrator, counterfactualTask, prepareTask, type AgentTask } from '../src';
import { CASE_ONE, CONFIG, TENANT, eventBySuffix, prepareCase } from './helpers';
import { baseOf, classifierTask, hypothesisTask, timelineTask, viewUpTo } from './tasks';

const POISON =
  'ROOT CAUSE IS A QUANTUM FLUX CAPACITOR AT 192.0.2.77 (host qfc-77.poison.example.net)';

const p = prepareCase(CASE_ONE);
const deps = new AiOrchestrator({ config: DEFAULT_MODEL_CONFIG }).prepareDependencies;
const prep = (task: AgentTask) =>
  prepareTask(task, 'req_fixed', 'model-x', deps, { applyBudget: false });

/** Rewrites every event after `eventId` (content and timestamps, order preserved). */
function mutateFuture(events: readonly CaseEvent[], eventId: string): CaseEvent[] {
  const cut = events.find((e) => e.id === eventId)?.sequence ?? 0;
  return events.map((e) =>
    e.sequence > cut
      ? {
          ...e,
          title: POISON,
          body: `${POISON} ${e.sequence}`,
          timestamp: new Date(Date.parse(e.timestamp) + 3_600_000).toISOString(),
        }
      : e,
  );
}

const poisonedResolution: CaseResolution | null = p.normalized.resolution
  ? {
      ...p.normalized.resolution,
      summary: POISON,
      rootCause: POISON,
      workaround: POISON,
      permanentFix: POISON,
    }
  : null;

/** Full analysis of the mutated record, exactly as the API would run it. */
function mutatedWorld(eventId: string) {
  const events = mutateFuture(p.normalized.events, eventId);
  const view = createFullView(events, poisonedResolution);
  const analysis = runDeterministicAnalysis({ view, pack: p.pack, config: CONFIG, ctx: p.ctx });
  return { events, analysis, view };
}

describe('temporal integrity of AI context [FR-CF-02] [FR-TL-06]', () => {
  it('[FR-CF-02] changing events and the resolution after the fork never changes the counterfactual prompt or hash', () => {
    const fork = p.analysis.forks.find((f) => f.eventId === eventBySuffix(p, 'e09').id);
    if (!fork) throw new Error('missing fork');
    const original = prep(cfTask('e09'));

    const world = mutatedWorld(fork.eventId);
    const mutatedFork = world.analysis.forks.find((f) => f.eventId === fork.eventId);
    if (!mutatedFork) throw new Error('missing mutated fork');
    const mutated = prep(
      counterfactualTask({
        tenantId: TENANT,
        caseId: p.ctx.caseId,
        analysisRunId: p.ctx.runId,
        analysis: world.analysis,
        fork: mutatedFork,
        strategy: 'balanced',
        events: world.events,
        resolution: poisonedResolution,
        pack: p.pack,
        config: CONFIG,
        ctx: p.ctx,
        rolloutCount: 40,
      }),
    );

    expect(mutated.fit.built.contextHash).toBe(original.fit.built.contextHash);
    expect(mutated.messages).toEqual(original.messages);
    expect(JSON.stringify(mutated.messages)).not.toContain('QUANTUM');
    expect(JSON.stringify(mutated.messages)).not.toContain('192.0.2.77');
  });

  for (const [name, make] of [
    ['timeline analyzer', timelineTask],
    ['evidence classifier', classifierTask],
    ['hypothesis generator', hypothesisTask],
  ] as const) {
    it(`[FR-TL-06] future changes never alter the ${name} prompt for an as-of window`, () => {
      const cut = 'e14';
      const world = mutatedWorld(eventBySuffix(p, cut).id);
      const view = viewUpTo(p, cut);
      const mutatedView = createTemporalView(world.events, eventBySuffix(p, cut).timestamp);
      const a = prep(make(p, view));
      const b = prep({
        ...make(p, mutatedView),
        input: { ...baseOf(p, mutatedView), analysis: world.analysis },
      });
      expect(b.fit.built.contextHash).toBe(a.fit.built.contextHash);
      expect(b.messages).toEqual(a.messages);
      expect(
        a.fit.built.context.events.every(
          (e) => Date.parse(e.at) <= Date.parse(eventBySuffix(p, cut).timestamp),
        ),
      ).toBe(true);
    });
  }

  it('[FR-CF-02] negative control: changing a visible event does change the context hash', () => {
    const view = viewUpTo(p, 'e14');
    const original = prep(hypothesisTask(p, view));
    const events = p.normalized.events.map((e) =>
      e.id === eventBySuffix(p, 'e05').id
        ? { ...e, body: `${e.body} Additional visible detail about resolver 10.99.99.99.` }
        : e,
    );
    const mutatedView = createTemporalView(events, eventBySuffix(p, 'e14').timestamp);
    const analysis = runDeterministicAnalysis({
      view: mutatedView,
      pack: p.pack,
      config: CONFIG,
      ctx: p.ctx,
    });
    const changed = prep({
      agent: 'hypothesis_generator',
      input: { ...baseOf(p, mutatedView), analysis },
    });
    expect(changed.fit.built.contextHash).not.toBe(original.fit.built.contextHash);
  });

  it('[FR-CF-02] the pre-resolution context never contains the resolution or later event ids', () => {
    const task = cfTask('e09');
    const built = prep(task).fit.built;
    const text = JSON.stringify(built.context);
    expect(built.context.boundary.resolutionIncluded).toBe(false);
    const later = p.normalized.events
      .filter((e) => e.sequence >= eventBySuffix(p, 'e09').sequence)
      .map((e) => `"id":"${e.id}"`);
    for (const marker of later) expect(text).not.toContain(marker);
    const resolution = p.normalized.resolution;
    expect(resolution).not.toBeNull();
    expect(text).not.toContain(resolution?.rootCause.slice(0, 40) ?? 'x');
  });
});

function cfTask(suffix: string): AgentTask {
  const fork = p.analysis.forks.find((f) => f.eventId === eventBySuffix(p, suffix).id);
  if (!fork) throw new Error('missing fork');
  return counterfactualTask({
    tenantId: TENANT,
    caseId: p.ctx.caseId,
    analysisRunId: p.ctx.runId,
    analysis: p.analysis,
    fork,
    strategy: 'balanced',
    events: p.normalized.events,
    resolution: p.normalized.resolution,
    pack: p.pack,
    config: CONFIG,
    ctx: p.ctx,
    rolloutCount: 40,
  });
}
