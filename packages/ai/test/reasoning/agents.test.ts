import { describe, expect, it } from 'vitest';
import {
  AGENT_NAMES,
  CaseCriticOutputSchema,
  CaseReasonerOutputSchema,
  DEFAULT_MODEL_CONFIG,
} from '@caseguard/schemas';
import {
  AGENT_CATALOG,
  AiOrchestrator,
  OUTPUT_SCHEMA_IDS,
  OUTPUT_SCHEMAS,
  createPromptRegistry,
  prepareTask,
} from '../../src';
import { MODEL_ASSISTANCE_NOT_USED } from '../../src/providers/deterministic/reasoning-handlers';
import { baseOf } from '../tasks';
import { conclusionsOf, one, reasonerTask, view, budgetOf } from './case-one';

const deps = new AiOrchestrator({ config: DEFAULT_MODEL_CONFIG }).prepareDependencies;
const BLOCK =
  /<<<CASEGUARD_DATA name="([a-z]+)" nonce="[a-f0-9]{16}">>>\n([\s\S]*?)\n<<<END_CASEGUARD_DATA nonce="[a-f0-9]{16}">>>/g;

const blocksOf = (user: string): Record<string, unknown> =>
  Object.fromEntries(
    [...user.matchAll(BLOCK)].map((m) => [m[1] ?? '', JSON.parse(m[2] ?? 'null') as unknown]),
  );

describe('the two agents of the model-assisted review', () => {
  it('are in every table that has one entry per agent', () => {
    for (const agent of ['case_reasoner', 'case_critic'] as const) {
      expect(AGENT_NAMES).toContain(agent);
      expect(AGENT_CATALOG[agent].name).toBe(agent);
      expect(OUTPUT_SCHEMAS[agent]).toBeDefined();
      expect(OUTPUT_SCHEMA_IDS[agent]).toMatch(/^caseguard\.case-(reasoner|critic)\.v1$/);
      expect(DEFAULT_MODEL_CONFIG.agentBudgets[agent]).toBeDefined();
      expect(createPromptRegistry().get(agent).version).toBe('1.0.0');
    }
    expect(Object.keys(AGENT_CATALOG).sort()).toEqual([...AGENT_NAMES].sort());
    expect(OUTPUT_SCHEMAS.case_reasoner).toBe(CaseReasonerOutputSchema);
    expect(OUTPUT_SCHEMAS.case_critic).toBe(CaseCriticOutputSchema);
  });

  it('read only what happened before the boundary, and work from the text they quote', () => {
    for (const agent of ['case_reasoner', 'case_critic'] as const) {
      const meta = AGENT_CATALOG[agent];
      expect(meta.temporalMode).toBe('pre_resolution');
      expect(meta.execution).toBe('model_or_deterministic');
      expect(meta.maxTrimLevel).toBe(1);
      expect(meta.sections.recognisedActions).toBe(false);
      expect(meta.sections.evidence).toBe(false);
      expect(meta.sections.claims).toBe('none');
    }
  });

  it('are given budgets that hold the untrimmed events', () => {
    const { case_reasoner: reasoner, case_critic: critic } = DEFAULT_MODEL_CONFIG.agentBudgets;
    expect(reasoner?.maxInputTokens).toBeGreaterThanOrEqual(16_000);
    expect(critic?.maxInputTokens).toBeGreaterThanOrEqual(16_000);
  });

  describe('the context of the reasoner', () => {
    const prepared = prepareTask(reasonerTask(), 'req_agents', 'm', deps, { applyBudget: false });
    const blocks = blocksOf(prepared.messages[1]?.content ?? '');

    it('holds the events and a vocabulary with descriptions, and nothing the engine concluded', () => {
      expect(Object.keys(blocks).sort()).toEqual(['events', 'knowledge']);
      const knowledge = blocks.knowledge as {
        signals: { id: string; description: string }[];
        actions: { id: string; description: string; destructive?: boolean }[];
        requirements: { id: string; description: string }[];
        hypotheses: { id: string }[];
      };
      expect(knowledge.signals.length).toBeGreaterThan(10);
      expect(knowledge.signals.every((s) => s.description.length > 0)).toBe(true);
      expect(knowledge.actions.every((a) => a.description.length > 0)).toBe(true);
      expect(knowledge.requirements.every((r) => r.description.length > 0)).toBe(true);
      expect(knowledge.actions.every((a) => !('destructive' in a))).toBe(true);
    });

    it('does not label an event with the action the engine recognised in it', () => {
      const events = blocks.events as { action: string | null }[];
      expect(events.length).toBe(view.events.length);
      expect(events.every((e) => e.action === null)).toBe(true);
    });

    it('is never compressed past level 1: a case that does not fit at level 1 is refused', () => {
      expect(prepared.fit.level).toBeLessThanOrEqual(1);
      const tiny = prepareTask(reasonerTask(), 'req_agents', 'm', deps, { applyBudget: true });
      expect(tiny.fit.fits).toBe(true);
      const small = new AiOrchestrator({
        config: {
          ...DEFAULT_MODEL_CONFIG,
          agentBudgets: {
            ...DEFAULT_MODEL_CONFIG.agentBudgets,
            case_reasoner: { ...budgetOf('case_reasoner'), maxInputTokens: 400 },
          },
        },
      }).prepareDependencies;
      const refused = prepareTask(reasonerTask(), 'req_agents', 'm', small, { applyBudget: true });
      expect(refused.fit.fits).toBe(false);
      expect(refused.fit.level).toBe(1);
    });
  });

  describe('the context of the critic', () => {
    it('masks a secret-like value in a conclusion before the critic sees it', () => {
      const conclusions = conclusionsOf().map((c, i) =>
        i === 0 ? { ...c, text: 'The service uses api_key=FAKE0000FAKE0000 for every call.' } : c,
      );
      const prepared = prepareTask(
        { agent: 'case_critic', input: { ...baseOf(one, view), conclusions } },
        'req_agents',
        'm',
        deps,
        { applyBudget: false },
      );
      const user = prepared.messages[1]?.content ?? '';
      expect(user).not.toContain('FAKE0000FAKE0000');
      expect(user).toContain('[REDACTED:api_key_assignment]');
    });
    it('holds the events, the hypotheses of the pack and the numbered conclusions under review', () => {
      const conclusions = conclusionsOf();
      const prepared = prepareTask(
        { agent: 'case_critic', input: { ...baseOf(one, view), conclusions } },
        'req_agents',
        'm',
        deps,
        { applyBudget: false },
      );
      const blocks = blocksOf(prepared.messages[1]?.content ?? '');
      expect(Object.keys(blocks).sort()).toEqual(['events', 'focus', 'knowledge']);
      const focus = blocks.focus as { conclusions: { id: string; source: string; text: string }[] };
      expect(focus.conclusions.map((c) => c.id)).toEqual(conclusions.map((c) => c.id));
      expect(focus.conclusions.some((c) => c.source === 'engine')).toBe(true);
      expect(JSON.stringify(focus)).not.toContain('"ref"');
      const knowledge = blocks.knowledge as { hypotheses: unknown[]; signals: unknown[] };
      expect(knowledge.hypotheses.length).toBeGreaterThan(0);
      expect(knowledge.signals).toEqual([]);
    });
  });

  describe('with the deterministic provider', () => {
    it('propose nothing, and say so in the output itself', async () => {
      const orchestrator = new AiOrchestrator({ config: DEFAULT_MODEL_CONFIG });
      const reasoner = await orchestrator.runAgentTask({ task: reasonerTask() });
      expect(reasoner.source).toBe('deterministic');
      expect(CaseReasonerOutputSchema.parse(reasoner.result)).toMatchObject({
        signals: [],
        contradictions: [],
        missingEvidence: [],
        missedSteps: [],
        counterfactuals: [],
        recommendations: [],
        synthesis: null,
      });
      expect(reasoner.result.uncertainty.note).toContain(MODEL_ASSISTANCE_NOT_USED);
      expect(reasoner.modelExecution).toMatchObject({
        provider: 'deterministic',
        simulated: true,
        resultSource: 'deterministic',
      });

      const critic = await orchestrator.runAgentTask({
        task: {
          agent: 'case_critic',
          input: { ...baseOf(one, view), conclusions: conclusionsOf() },
        },
      });
      expect(critic.source).toBe('deterministic');
      expect(CaseCriticOutputSchema.parse(critic.result)).toMatchObject({ result: null });
      expect(critic.result.uncertainty.note).toContain(MODEL_ASSISTANCE_NOT_USED);
    });

    it('are the same every time', async () => {
      const orchestrator = new AiOrchestrator({ config: DEFAULT_MODEL_CONFIG });
      const first = await orchestrator.runAgentTask({ task: reasonerTask() });
      const second = await orchestrator.runAgentTask({ task: reasonerTask() });
      expect(second.result).toEqual(first.result);
    });
  });
});
