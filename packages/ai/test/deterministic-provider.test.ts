import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_CONFIG } from '@caseguard/schemas';
import {
  analyzeView,
  buildTimelineResponse,
  generateCounterfactuals,
  topHypotheses,
} from '@caseguard/domain';
import {
  AiOrchestrator,
  DeterministicProvider,
  ProviderError,
  TokenGovernor,
  prepareTask,
  type AgentTask,
  type ModelRequest,
} from '../src';
import { CASE_ONE, CASE_TWO, CONFIG, prepareCase } from './helpers';
import { FakeClock } from './fakes';
import {
  cfTask,
  classifierTask,
  coachTask,
  forkTask,
  hypothesisTask,
  qualityTask,
  skillTask,
  timelineTask,
  validOutput,
  viewUpTo,
  wholeRecordView,
} from './tasks';

const orchestrator = new AiOrchestrator({ config: DEFAULT_MODEL_CONFIG });

function requestFor(task: AgentTask): ModelRequest {
  const prepared = prepareTask(
    task,
    'req_test',
    'deterministic-knowledge-pack',
    orchestrator.prepareDependencies,
    {
      applyBudget: false,
    },
  );
  return {
    requestId: 'req_test',
    tenantId: task.input.tenantId,
    agent: task.agent,
    messages: prepared.messages,
    structuredOutput: {
      name: prepared.prompt.outputSchemaId,
      schema: prepared.prompt.jsonSchema,
      strict: true,
    },
    maxOutputTokens: 4000,
    temperature: 0,
    timeoutMs: 30_000,
    model: null,
    task,
  };
}

const one = prepareCase(CASE_ONE);
const two = prepareCase(CASE_TWO);

describe('DeterministicProvider parity with the domain engine', () => {
  it('[FR-TK-03] labels every response as simulated, estimated and deterministic', async () => {
    const provider = new DeterministicProvider();
    const response = await provider.complete(requestFor(timelineTask(one)));
    expect(response.provider).toBe('deterministic');
    expect(response.simulated).toBe(true);
    expect(response.usage.source).toBe('estimated');
    expect(response.usage.totalTokens).toBe(
      response.usage.promptTokens + response.usage.completionTokens,
    );
    expect(response.model).toBe('deterministic-knowledge-pack');
    expect(provider.describe().validationNote).toMatch(/simulated or estimated/i);
  });

  it('[FR-TK-03] is reproducible: the same task yields byte-identical output', async () => {
    const provider = new DeterministicProvider();
    const a = await provider.complete(requestFor(hypothesisTask(one)));
    const b = await provider.complete(requestFor(hypothesisTask(one)));
    expect(JSON.stringify(a.output)).toBe(JSON.stringify(b.output));
  });

  for (const [name, p] of [
    ['case one', one],
    ['case two', two],
  ] as const) {
    it(`[FR-EV-01] evidence classification equals the domain ledger claim by claim (${name})`, () => {
      const output = validOutput(classifierTask(p));
      const expected = p.analysis.claims
        .filter((c) => c.eventId !== null)
        .map((c) => [c.id, c.aiCategory]);
      expect(output.classifications.map((c) => [c.claimId, c.category])).toEqual(expected);
    });

    it(`[FR-FK-01] fork proposals equal the domain fork detector (${name})`, () => {
      const output = validOutput(forkTask(p));
      expect(output.forks.map((f) => [f.eventId, f.category])).toEqual(
        p.analysis.forks.map((f) => [f.eventId, f.category]),
      );
    });

    it(`[FR-TL-04] delays and repeated diagnostics equal the domain timeline view (${name})`, () => {
      const output = validOutput(timelineTask(p));
      const view = wholeRecordView(p);
      const domain = buildTimelineResponse({
        caseRecord: { id: p.ctx.caseId, openedAt: view.events[0]?.timestamp ?? view.asOf },
        events: view.events,
        analysis: p.analysis,
        asOf: null,
        limit: view.events.length,
      });
      expect(output.delays.map((d) => [d.fromEventId, d.toEventId, d.minutes])).toEqual(
        domain.delays.map((d) => [d.fromEventId, d.toEventId, Math.round(d.minutes)]),
      );
      expect(output.repeatedDiagnostics.map((r) => r.eventIds)).toEqual(
        domain.repeats
          .filter((r) => r.repeatOfEventId !== r.eventId)
          .map((r) => [r.repeatOfEventId, r.eventId]),
      );
    });
  }

  it('[FR-HY-01] hypothesis standing at an earlier point equals the domain belief as of that point', () => {
    const view = viewUpTo(one, 'e04');
    const task = hypothesisTask(one, view);
    const output = validOutput(task);
    const belief = analyzeView(view, one.pack, one.ctx.caseId).belief;
    const leader = topHypotheses(belief, 1)[0];
    const proposed = output.hypotheses.find((h) => h.key === leader?.id);
    expect(proposed).toBeDefined();
    expect(proposed?.likelihood).toBe(
      (leader?.p ?? 0) >= 0.6 ? 'high' : (leader?.p ?? 0) >= 0.25 ? 'medium' : 'low',
    );
    // Case One's DNS hypothesis is only a candidate at e04; it is confirmed by the end of the record.
    const final = validOutput(hypothesisTask(one));
    expect(final.hypotheses.find((h) => h.key === 'hyp.dns-resolution')?.status).toBe('confirmed');
  });

  it('[FR-CF-01] counterfactual steps equal a direct domain generateCounterfactuals call', () => {
    for (const strategy of ['balanced', 'lowest_customer_effort', 'fastest_diagnosis'] as const) {
      const task = cfTask(one, 'e09', strategy);
      const output = validOutput(task);
      const direct = generateCounterfactuals({
        analysis: one.analysis,
        fork: task.input.fork,
        strategies: [strategy],
        events: one.normalized.events,
        resolution: one.normalized.resolution,
        pack: one.pack,
        config: CONFIG,
        ctx: one.ctx,
        rolloutCount: 40,
      }).scenarios[0];
      expect(output.steps.map((s) => s.actionKey)).toEqual(direct?.steps.map((s) => s.actionKey));
      expect(output.steps.map((s) => s.evidenceUsedIds)).toEqual(
        direct?.steps.map((s) => s.evidenceUsedIds),
      );
      expect(output.steps.map((s) => s.expectedOutcomeId)).toEqual(
        direct?.steps.map((s) => s.predictedOutcome.outcomeId),
      );
      expect(output.labels).toEqual({ simulated: true, estimated: true });
      expect(output.forkEventId).toBe(task.input.fork.eventId);
    }
  });

  it('[FR-QI-02] quality findings cover the highest-impact forks and carry no numeric score', () => {
    const output = validOutput(qualityTask(one));
    const top = [...one.analysis.forks]
      .sort((a, b) => b.impactScore - a.impactScore || (a.id < b.id ? -1 : 1))
      .slice(0, 8)
      .map((f) => f.eventId);
    const cited = new Set(output.findings.flatMap((f) => f.eventIds));
    for (const id of top) expect(cited.has(id)).toBe(true);
    expect(JSON.stringify(output)).not.toMatch(/compositeScore|"score"/);
    expect(output.limitations.length).toBeGreaterThan(0);
  });

  it('[FR-CO-01] coaching notes are constructive, cite evidence and never rank people', () => {
    const output = validOutput(coachTask(one));
    expect(output.missedOpportunity?.eventIds.length).toBeGreaterThan(0);
    expect(output.limitations.join(' ')).toMatch(/does not rate, rank or discipline/i);
    expect(JSON.stringify(output)).not.toMatch(/incompetent|lazy|worst/i);
  });

  it('[FR-SK-03] SkillDNA proposals always require human approval and use only safe pack actions', () => {
    const output = validOutput(skillTask(one, 'e09'));
    expect(output.requiresHumanApproval).toBe(true);
    for (const step of output.steps) {
      const action = step.actionKey ? one.pack.actions.get(step.actionKey) : undefined;
      expect(action).toBeDefined();
      expect(action?.destructive).toBe(false);
      expect(action?.requiresApproval).toBe(false);
    }
  });

  it('[FR-TK-02] supports plugging richer domain engines through handler overrides', async () => {
    const task = timelineTask(one);
    const base = validOutput(task);
    const provider = new DeterministicProvider({
      overrides: {
        timeline_analyzer: () => ({ ...base, summary: 'Overridden by the API layer.' }),
      },
    });
    const response = await provider.complete(requestFor(task));
    expect((response.output as { summary: string }).summary).toBe('Overridden by the API layer.');
  });

  it('rejects the token-governor task when no governor is wired and honours cancellation', async () => {
    const provider = new DeterministicProvider();
    const governorTask: AgentTask = {
      agent: 'token_governor',
      input: {
        tenantId: 'tenant_test',
        caseId: null,
        targetAgent: 'quality_judge',
        estimatedInputTokens: 100,
        providerKind: 'azure-openai',
      },
    };
    await expect(provider.complete(requestFor(governorTask))).rejects.toMatchObject({
      code: 'not_configured',
    });

    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.complete({ ...requestFor(timelineTask(one)), signal: controller.signal }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('[FR-TK-02] the token-governor agent reports route, limits and budget verdict from code', async () => {
    const governor = new TokenGovernor({ config: DEFAULT_MODEL_CONFIG, clock: new FakeClock() });
    const provider = new DeterministicProvider({ governor });
    const task: AgentTask = {
      agent: 'token_governor',
      input: {
        tenantId: 'tenant_test',
        caseId: null,
        targetAgent: 'quality_judge',
        estimatedInputTokens: 500,
        providerKind: 'deterministic',
      },
    };
    const response = await provider.complete(requestFor(task));
    expect(response.output).toMatchObject({
      allowed: true,
      tier: 'deterministic',
      limits: { maxInputTokens: 12_000 },
    });
  });
});
