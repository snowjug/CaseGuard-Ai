import { describe, expect, it } from 'vitest';
import { createTemporalView } from '@caseguard/domain';
import { DEFAULT_MODEL_CONFIG, type CounterfactualStrategy } from '@caseguard/schemas';
import {
  AiOrchestrator,
  SemanticCache,
  prepareTask,
  validateAgentOutput,
  type AgentTask,
  type ValidationContext,
} from '../src';
import { CONFIG, eventBySuffix } from './helpers';
import { FakeClock, ScriptedProvider } from './fakes';
import { one, run, setup } from './orchestrator-harness';
import {
  baseOf,
  cfTask,
  classifierTask,
  skillTask,
  validOutput,
  viewUpTo,
  wholeRecordView,
} from './tasks';

const STRATEGIES: CounterfactualStrategy[] = [
  'balanced',
  'lowest_customer_effort',
  'fastest_diagnosis',
];

const META = {
  provider: 'azure-openai',
  model: 'gpt-test',
  usage: {
    promptTokens: 100,
    completionTokens: 20,
    cachedTokens: 0,
    totalTokens: 120,
    source: 'measured',
  },
} as const;

const deps = new AiOrchestrator({ config: DEFAULT_MODEL_CONFIG }).prepareDependencies;

function keysOf(task: AgentTask) {
  const prepared = prepareTask(task, 'req_cache_binding', 'gpt-test', deps, { applyBudget: false });
  if (!prepared.cacheScope || !prepared.cacheInput) throw new Error('task is not cacheable');
  return { scope: prepared.cacheScope, input: prepared.cacheInput, vctx: prepared.vctx };
}

const lenientCache = () =>
  new SemanticCache<{ id: string }>({
    clock: new FakeClock(),
    enabled: true,
    ttlSeconds: 3_600,
    // The lowest threshold the governance schema allows: the most generous near-matching possible.
    similarityThreshold: 0.5,
  });

const codes = (report: { issues: { code: string }[] }): string[] =>
  report.issues.map((i) => i.code);

describe('a cached proposal answers only the request it was computed for [FR-TK-02]', () => {
  it('[FR-CF-01] the three strategies of one fork each get their own model call and their own proposal', async () => {
    const tasks = STRATEGIES.map((strategy) => cfTask(one, 'e09', strategy));
    const provider = new ScriptedProvider(tasks.map((task) => ({ output: validOutput(task) })));
    const { orchestrator } = setup(provider);
    const results = [];
    for (const task of tasks) results.push(await run(orchestrator, task));

    expect(provider.requests).toHaveLength(3);
    expect(results.map((r) => r.source)).toEqual(['model', 'model', 'model']);
    expect(results.map((r) => (r.result as { strategy: string }).strategy)).toEqual(STRATEGIES);
    expect(results.map((r) => r.modelExecution.status)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
    ]);
    expect(orchestrator.getHealth().cache).toMatchObject({ hits: 0, nearHits: 0, size: 3 });
  }, 90_000);

  it('[FR-TK-02] an identical request is still answered from the cache (exact match)', async () => {
    const task = cfTask(one, 'e09', 'lowest_customer_effort');
    const provider = new ScriptedProvider([{ output: validOutput(task) }]);
    const { orchestrator } = setup(provider);
    await run(orchestrator, task);
    const second = await run(orchestrator, task);
    expect(provider.requests).toHaveLength(1);
    expect(second.source).toBe('cache');
    expect((second.result as { strategy: string }).strategy).toBe('lowest_customer_effort');
  });

  it('[FR-TK-02] requests that differ in anything but event prose never share a bucket, even at the most lenient threshold', () => {
    const claimIds = one.analysis.claims.slice(0, 2).map((c) => c.id);
    expect(claimIds).toHaveLength(2);
    const families: Record<string, [string, AgentTask][]> = {
      'counterfactual paths for one fork': [
        ...STRATEGIES.map((s): [string, AgentTask] => [`strategy ${s}`, cfTask(one, 'e09', s)]),
        [
          'stricter risk ceiling (different allowed actions)',
          cfTask(one, 'e09', 'balanced', 40, { ...CONFIG, riskCeiling: 0.05 }),
        ],
      ],
      'evidence classification of the same window': [
        ['every claim', classifierTask(one)],
        [
          'two claims only',
          {
            agent: 'evidence_classifier',
            input: { ...baseOf(one, wholeRecordView(one)), claimIds },
          },
        ],
      ],
      'skill extraction from one fork': STRATEGIES.map((s): [string, AgentTask] => [
        `scenario ${s}`,
        skillTask(one, 'e09', s),
      ]),
    };

    let pairs = 0;
    for (const [family, variants] of Object.entries(families)) {
      const keyed = variants.map(([name, task]) => ({ name, ...keysOf(task) }));
      for (const stored of keyed) {
        for (const asked of keyed) {
          const cache = lenientCache();
          cache.set(stored.scope, stored.input, { id: stored.name }, META);
          const hit = cache.get(asked.scope, asked.input);
          if (stored === asked) {
            expect(hit?.kind, `${family}: ${asked.name} should hit its own entry`).toBe('exact');
          } else {
            pairs++;
            expect(hit, `${family}: "${stored.name}" must not answer "${asked.name}"`).toBeNull();
          }
        }
      }
    }
    expect(pairs).toBe(12 + 2 + 6);
  }, 90_000);

  it('[FR-TK-02] near-matching still works for what it is for: slightly different event prose in the same structure', () => {
    const original = keysOf({
      agent: 'hypothesis_generator',
      input: baseOf(one, viewUpTo(one, 'e14')),
    });
    const events = one.normalized.events.map((e, i) =>
      i === 3
        ? {
            ...e,
            body: `Customer added that the same sign-in failure was seen again this morning. ${e.body}`,
          }
        : e,
    );
    const view = createTemporalView(events, eventBySuffix(one, 'e14').timestamp);
    const edited = keysOf({ agent: 'hypothesis_generator', input: baseOf(one, view) });

    expect(edited.scope).toEqual(original.scope);
    expect(edited.input.hash).not.toBe(original.input.hash);
    const cache = new SemanticCache<{ id: string }>({
      clock: new FakeClock(),
      enabled: true,
      ttlSeconds: 3_600,
      similarityThreshold: DEFAULT_MODEL_CONFIG.semanticCache.similarityThreshold,
    });
    cache.set(original.scope, original.input, { id: 'original' }, META);
    const hit = cache.get(edited.scope, edited.input);
    expect(hit?.kind).toBe('near');
    expect(hit?.value).toEqual({ id: 'original' });
  });
});

describe('a proposal must answer what was requested [FR-CF-01]', () => {
  const requested = cfTask(one, 'e09', 'lowest_customer_effort');
  const otherStrategy = () => validOutput(cfTask(one, 'e09', 'balanced'));
  const vctxOf = (task: AgentTask): ValidationContext => {
    const { vctx } = keysOf(task);
    if (!vctx) throw new Error('no validation context');
    return vctx;
  };

  it('[FR-CF-01] rejects a proposal written for a different strategy than the one requested', () => {
    const report = validateAgentOutput(
      'counterfactual_simulator',
      otherStrategy(),
      vctxOf(requested),
    );
    expect(codes(report)).toContain('strategy_mismatch');
    expect(report.ok).toBe(false);
    expect(report.outcome.citationsValid).toBe(false);
    expect(JSON.stringify(report.issues)).not.toContain('balanced');
  });

  it('[FR-CF-01] accepts the proposal for the strategy that was requested', () => {
    const report = validateAgentOutput(
      'counterfactual_simulator',
      validOutput(requested),
      vctxOf(requested),
    );
    expect(codes(report)).not.toContain('strategy_mismatch');
    expect(report.ok).toBe(true);
  });

  it('[FR-CF-01] still rejects a proposal anchored on another decision point', () => {
    const out = validOutput(requested);
    out.forkEventId = eventBySuffix(one, 'e03').id;
    expect(
      codes(validateAgentOutput('counterfactual_simulator', out, vctxOf(requested))),
    ).toContain('wrong_anchor');
  });

  it('[FR-TK-02] never serves a cached proposal for another strategy, even if one were stored under this request', async () => {
    const provider = new ScriptedProvider([{ output: validOutput(requested) }]);
    const { orchestrator } = setup(provider);
    const { scope, input } = keysOf(requested);
    orchestrator.cache?.set(scope, input, otherStrategy(), META);

    const result = await run(orchestrator, requested);
    expect(provider.requests).toHaveLength(1);
    expect(result.source).toBe('model');
    expect((result.result as { strategy: string }).strategy).toBe('lowest_customer_effort');
  });
});
