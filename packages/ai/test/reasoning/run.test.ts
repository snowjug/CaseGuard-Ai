import { describe, expect, it } from 'vitest';
import { AiFindingSchema, DEFAULT_MODEL_CONFIG } from '@caseguard/schemas';
import {
  AiOrchestrator,
  ASSISTANCE_REASON_CODES,
  runModelAssistedReview,
  type ReviewResult,
  type Script,
} from '../../src';
import { createTemporalView } from '@caseguard/domain';
import {
  VALID_PROPOSAL_COUNT,
  conclusionsOf,
  criticReply,
  emptyCriticReply,
  one,
  reviewHarness,
  reviewInput,
  validReply,
} from './case-one';

/** The reasoner answers with `validReply()`; the critic questions the engine's headline and the first signal. */
function happyScript(): Script {
  const conclusions = conclusionsOf();
  const idOf = (ref: string): string => conclusions.find((c) => c.ref === ref)?.id ?? 'C?';
  return {
    case_reasoner: { output: validReply() },
    case_critic: {
      output: criticReply([{ targetId: conclusions[0]?.id ?? 'C1' }, { targetId: idOf('sg1') }]),
    },
  };
}

const noFindings = (result: ReviewResult): void => {
  expect(result.findings).toEqual([]);
  expect(result.engineNotes).toEqual([]);
};

describe('model-assisted review', () => {
  describe('when no model is asked', () => {
    it('is off with the deterministic provider: nothing is called, and it says so', async () => {
      const orchestrator = new AiOrchestrator({ config: DEFAULT_MODEL_CONFIG });
      const result = await runModelAssistedReview({ orchestrator }, reviewInput());
      noFindings(result);
      expect(result.executions).toEqual([]);
      expect(result.assistance).toMatchObject({
        mode: 'off',
        reasonCode: 'deterministic_provider',
        provider: 'deterministic',
        simulated: true,
        modelCalls: 0,
        requests: 0,
        cancelled: false,
        estimatedCostUsd: null,
        tokens: { total: 0, source: null },
      });
      expect(result.assistance.reason).toMatch(/off/i);
    });

    it('is off when no model deployment is configured', async () => {
      const h = reviewHarness(happyScript(), {
        config: {
          azureDeployment: '',
          routing: { defaultModel: 'deterministic-knowledge-pack', cheapModel: null, rules: [] },
        },
      });
      const result = await runModelAssistedReview(h.deps, reviewInput());
      noFindings(result);
      expect(result.assistance).toMatchObject({ mode: 'off', reasonCode: 'no_model_configured' });
      expect(h.provider.calls).toHaveLength(0);
    });

    it('is off when the case has no events in the view', async () => {
      const h = reviewHarness(happyScript());
      const empty = createTemporalView(one.normalized.events, '2000-01-01T00:00:00.000Z');
      const result = await runModelAssistedReview(h.deps, reviewInput({ view: empty }));
      noFindings(result);
      expect(result.assistance).toMatchObject({ mode: 'off', reasonCode: 'no_events' });
      expect(h.provider.calls).toHaveLength(0);
    });

    it('refuses to start a review inside a review', async () => {
      let nested: Promise<ReviewResult> | null = null;
      const holder: { deps?: ReturnType<typeof reviewHarness>['deps'] } = {};
      const script = happyScript();
      const h = reviewHarness({
        ...script,
        case_reasoner: () => {
          if (holder.deps) nested = runModelAssistedReview(holder.deps, reviewInput());
          return { output: validReply() };
        },
      });
      holder.deps = h.deps;
      const outer = await runModelAssistedReview(h.deps, reviewInput());
      const inner = await (nested as Promise<ReviewResult> | null);
      expect(inner?.assistance).toMatchObject({ mode: 'off', reasonCode: 'reentrant_call' });
      noFindings(inner as ReviewResult);
      expect(outer.assistance.mode).toBe('ran');
      expect(h.provider.calls).toHaveLength(2);
    });
  });

  describe('when the model answers', () => {
    it('returns findings for a person to review, never a decision, and never touches the case', async () => {
      const before = JSON.stringify(one.analysis);
      const input = reviewInput();
      const h = reviewHarness(happyScript());
      const result = await runModelAssistedReview(h.deps, input);

      expect(result.assistance).toMatchObject({
        mode: 'ran',
        reasonCode: 'ran',
        provider: 'scripted',
        simulated: true,
        cancelled: false,
        fallbackCount: 0,
        schemaFailures: 0,
        safetyBlocks: 0,
      });
      expect(result.findings).toHaveLength(VALID_PROPOSAL_COUNT);
      for (const finding of result.findings) {
        expect(AiFindingSchema.safeParse(finding).success).toBe(true);
        expect(finding.reviewState).toBe('pending');
        expect(finding.reviewRequired).toBe(finding.hybridStatus !== 'MODEL_CORROBORATED');
        expect(['DETERMINISTIC', 'REJECTED']).not.toContain(finding.hybridStatus);
        expect(finding.provenance).toMatchObject({
          agent: 'case_reasoner',
          provider: 'scripted',
          simulated: true,
        });
        expect(finding.evidence.length).toBeGreaterThan(0);
        for (const evidence of finding.evidence)
          expect(evidence).toMatchObject({ verified: true, verifiedIn: 'stored_text' });
      }
      expect(JSON.stringify(one.analysis)).toBe(before);
    });

    it('attaches the second look to the finding it is about, and the rest to the engine item', async () => {
      const h = reviewHarness(happyScript());
      const result = await runModelAssistedReview(h.deps, reviewInput());
      const signal = result.findings.find(
        (f) => f.type === 'signal' && f.statement.includes('MFA-required'),
      );
      expect(signal?.criticNotes).toHaveLength(1);
      expect(signal?.hybridStatus).toBe('NEEDS_HUMAN_REVIEW');
      expect(result.engineNotes).toHaveLength(1);
      expect(result.engineNotes[0]?.note.kind).toBe('unsupported_claim');
      expect(result.assistance.counts.criticNotes).toBe(2);
    });

    it('asks the reasoner once, and the critic once because the reasoner kept something', async () => {
      const h = reviewHarness(happyScript());
      const result = await runModelAssistedReview(h.deps, reviewInput());
      expect(h.provider.calls.map((c) => c.agent)).toEqual(['case_reasoner', 'case_critic']);
      expect(result.executions.map((e) => [e.agent, e.provider, e.status])).toEqual([
        ['case_reasoner', 'scripted', 'succeeded'],
        ['case_critic', 'scripted', 'succeeded'],
      ]);
      expect(result.assistance.modelCalls).toBe(2);
    });

    it('does not ask the critic when the reasoner kept nothing', async () => {
      const reasonerSays = {
        signals: [],
        contradictions: [],
        missingEvidence: [],
        missedSteps: [],
        counterfactuals: [],
        recommendations: [],
        synthesis: null,
        uncertainty: { level: 'high', note: 'Nothing in the record needs adding.' },
      };
      const h = reviewHarness({
        case_reasoner: { output: reasonerSays },
        case_critic: { output: emptyCriticReply() },
      });
      const result = await runModelAssistedReview(h.deps, reviewInput());
      expect(h.provider.calls.map((c) => c.agent)).toEqual(['case_reasoner']);
      noFindings(result);
      expect(result.assistance).toMatchObject({ mode: 'ran', reasonCode: 'ran', modelCalls: 1 });
      expect(result.assistance.counts).toMatchObject({ proposed: 0, kept: 0 });
    });

    it('does not ask the critic when every proposal was dropped, and says what was dropped, by code', async () => {
      const reply = validReply();
      for (const key of [
        'signals',
        'contradictions',
        'missingEvidence',
        'missedSteps',
        'counterfactuals',
        'recommendations',
      ]) {
        for (const item of reply[key] as Record<string, unknown>[])
          item.evidence = [{ eventId: 'no-such-event', excerpt: 'nothing here' }];
      }
      (reply.synthesis as Record<string, unknown>).evidence = [
        { eventId: 'no-such-event', excerpt: 'nothing here' },
      ];
      const h = reviewHarness({
        case_reasoner: { output: reply },
        case_critic: { output: emptyCriticReply() },
      });
      const result = await runModelAssistedReview(h.deps, reviewInput());
      expect(h.provider.calls).toHaveLength(1);
      noFindings(result);
      expect(result.assistance.counts).toMatchObject({ proposed: VALID_PROPOSAL_COUNT, kept: 0 });
      expect(result.assistance.counts.rejectedByCode.unknown_event).toBe(VALID_PROPOSAL_COUNT);
    });

    it('keeps the good proposals when some are dropped, and counts the drops', async () => {
      const reply = validReply();
      (reply.signals as Record<string, unknown>[])[1] = {
        ...(reply.signals as Record<string, unknown>[])[1],
        signalId: 'sig.not-in-the-pack',
      };
      const h = reviewHarness({
        case_reasoner: { output: reply },
        case_critic: { output: emptyCriticReply() },
      });
      const result = await runModelAssistedReview(h.deps, reviewInput());
      expect(result.findings).toHaveLength(VALID_PROPOSAL_COUNT - 1);
      expect(result.assistance.counts).toMatchObject({
        proposed: VALID_PROPOSAL_COUNT,
        kept: VALID_PROPOSAL_COUNT - 1,
        rejectedByCode: { unknown_vocabulary_id: 1 },
      });
      expect(result.assistance.schemaFailures).toBe(0);
    });

    it('reports a second look that could not be had, and keeps the findings', async () => {
      const h = reviewHarness({
        ...happyScript(),
        case_critic: { fail: { kind: 'server_error' } },
      });
      const result = await runModelAssistedReview(h.deps, reviewInput());
      expect(result.findings).toHaveLength(VALID_PROPOSAL_COUNT);
      expect(result.assistance).toMatchObject({
        mode: 'ran',
        reasonCode: 'ran_without_second_look',
      });
      expect(result.assistance.fallbackCount).toBe(1);
      expect(result.findings.every((f) => f.criticNotes.length === 0)).toBe(true);
    });
  });

  describe('when the model cannot be used, the review says why and shows no findings', () => {
    const cases: [string, Script, string][] = [
      ['a server error', { case_reasoner: { fail: { kind: 'server_error' } } }, 'provider_error'],
      ['a rate limit', { case_reasoner: { fail: { kind: 'rate_limited' } } }, 'provider_error'],
      ['a timeout', { case_reasoner: { fail: { kind: 'timeout' } } }, 'timeout'],
      [
        'a content filter block',
        { case_reasoner: { fail: { kind: 'content_filter' } } },
        'content_filtered',
      ],
      [
        'a reply that is not JSON, twice',
        { case_reasoner: { fail: { kind: 'malformed_json' } } },
        'rejected_by_validation',
      ],
      [
        'a reply that is cut off, twice',
        { case_reasoner: { output: validReply(), fail: { kind: 'truncated' } } },
        'rejected_by_validation',
      ],
      [
        'a reply of the wrong shape, twice',
        { case_reasoner: { fail: { kind: 'schema_violation' } } },
        'rejected_by_validation',
      ],
    ];

    it.each(cases)('%s', async (_name, script, reasonCode) => {
      const h = reviewHarness(script);
      const result = await runModelAssistedReview(h.deps, reviewInput());
      noFindings(result);
      expect(result.assistance).toMatchObject({ mode: 'fallback', reasonCode, cancelled: false });
      expect(result.assistance.fallbackCount).toBeGreaterThanOrEqual(1);
      expect(result.assistance.reason.length).toBeGreaterThan(10);
      expect(h.provider.calls.every((c) => c.agent === 'case_reasoner')).toBe(true);
      expect(result.executions).toHaveLength(1);
    });

    it('counts a reply that failed as a whole, and its repair', async () => {
      const h = reviewHarness({ case_reasoner: { fail: { kind: 'malformed_json' } } });
      const result = await runModelAssistedReview(h.deps, reviewInput());
      expect(h.provider.calls).toHaveLength(2);
      expect(result.assistance.modelCalls).toBe(2);
      expect(result.assistance.schemaFailures).toBeGreaterThanOrEqual(2);
    });

    it('counts a content filter block as a safety block', async () => {
      const h = reviewHarness({ case_reasoner: { fail: { kind: 'content_filter' } } });
      const result = await runModelAssistedReview(h.deps, reviewInput());
      expect(result.assistance.safetyBlocks).toBe(1);
    });

    it('uses a repaired reply: one bad reply, then a good one', async () => {
      const h = reviewHarness({
        ...happyScript(),
        case_reasoner: [{ fail: { kind: 'malformed_json' } }, { output: validReply() }],
      });
      const result = await runModelAssistedReview(h.deps, reviewInput());
      expect(result.assistance.mode).toBe('ran');
      expect(result.findings).toHaveLength(VALID_PROPOSAL_COUNT);
      expect(h.provider.calls.filter((c) => c.agent === 'case_reasoner')).toHaveLength(2);
      expect(result.assistance.schemaFailures).toBe(1);
    });

    it('opens the circuit after repeated failures and then does not call at all', async () => {
      const h = reviewHarness(
        { case_reasoner: { fail: { kind: 'server_error' } } },
        { config: { circuitBreaker: { failureThreshold: 2, resetMs: 60_000 }, maxRetries: 0 } },
      );
      for (let i = 0; i < 2; i++)
        await runModelAssistedReview(h.deps, reviewInput({ tenantId: `tenant_${i}` }));
      const callsBefore = h.provider.calls.length;
      const third = await runModelAssistedReview(h.deps, reviewInput({ tenantId: 'tenant_3' }));
      expect(third.assistance).toMatchObject({ mode: 'fallback', reasonCode: 'circuit_open' });
      expect(h.provider.calls).toHaveLength(callsBefore);
    });

    it('does not fit a case that is too long to quote, and does not call', async () => {
      const h = reviewHarness(happyScript(), {
        config: {
          agentBudgets: {
            ...DEFAULT_MODEL_CONFIG.agentBudgets,
            case_reasoner: {
              ...DEFAULT_MODEL_CONFIG.agentBudgets.case_reasoner,
              maxInputTokens: 400,
            },
          },
        },
      });
      const result = await runModelAssistedReview(h.deps, reviewInput());
      noFindings(result);
      expect(result.assistance).toMatchObject({ mode: 'fallback', reasonCode: 'input_too_large' });
      expect(h.provider.calls).toHaveLength(0);
    });
  });

  describe('what the review reports about itself is measured, not invented', () => {
    it('ties tokens, requests and calls to what the provider was asked and answered', async () => {
      const h = reviewHarness(happyScript());
      const result = await runModelAssistedReview(h.deps, reviewInput());
      const totals = h.provider.totals();
      const { assistance } = result;
      expect(assistance.modelCalls).toBe(totals.calls);
      expect(assistance.requests).toBe(totals.attempts);
      expect(assistance.tokens.prompt).toBe(totals.promptTokens);
      expect(assistance.tokens.completion).toBe(totals.completionTokens);
      expect(assistance.tokens.total).toBe(totals.promptTokens + totals.completionTokens);
      expect(assistance.tokens.source).toBe('estimated');
      expect(assistance.estimatedCostUsd).toBeNull();
      const rows = result.executions.reduce((n, e) => n + (e.usage?.totalTokens ?? 0), 0);
      expect(rows).toBe(assistance.tokens.total);
    });

    it('says measured when the provider reported the counts, and prices a call only with configured prices', async () => {
      const usage = { promptTokens: 2000, completionTokens: 500 };
      const h = reviewHarness(
        { ...happyScript(), case_reasoner: { output: validReply(), usage } },
        {
          config: {
            unitPrices: { inputPer1kUsd: 0.01, outputPer1kUsd: 0.03, cachedInputPer1kUsd: null },
          },
        },
      );
      const result = await runModelAssistedReview(h.deps, reviewInput());
      expect(result.assistance.tokens.source).toBe('mixed');
      const reasoner = result.executions[0];
      expect(reasoner?.usage).toMatchObject({
        promptTokens: 2000,
        completionTokens: 500,
        tokenSource: 'measured',
      });
      expect(reasoner?.usage?.estimatedCostUsd).toBeCloseTo(2 * 0.01 + 0.5 * 0.03);
      expect(result.assistance.estimatedCostUsd).not.toBeNull();
    });

    it('reports the time of the whole review, measured on the clock it was given', async () => {
      const holder: { advance?: (ms: number) => void } = {};
      const h = reviewHarness(
        {
          case_reasoner: { output: validReply(), delayMs: 700 },
          case_critic: { output: emptyCriticReply(), delayMs: 300 },
        },
        { provider: { sleep: async (ms) => holder.advance?.(ms) } },
      );
      holder.advance = (ms) => h.clock.advance(ms);
      const result = await runModelAssistedReview(h.deps, reviewInput());
      expect(result.assistance.latencyMs).toBe(1000);
      expect(result.executions.map((e) => e.latencyMs)).toEqual([700, 300]);
    });

    it('does not put the text of the case, a prompt or a reply into its records, logs or metrics', async () => {
      const h = reviewHarness(happyScript());
      const result = await runModelAssistedReview(h.deps, reviewInput());
      const seen = JSON.stringify([
        result.executions,
        result.assistance,
        h.logger.entries,
        h.metrics.entries,
      ]);
      for (const text of [
        'Likely a CA policy issue',
        'AADSTS50076',
        'ERR_NAME_NOT_RESOLVED',
        'Contoso',
        'head office',
      ]) {
        expect(seen).not.toContain(text);
      }
    });

    it('has a reason code for every mode it can report', () => {
      expect(ASSISTANCE_REASON_CODES).toEqual(
        expect.arrayContaining([
          'ran',
          'deterministic_provider',
          'cancelled',
          'budget_exceeded',
          'timeout',
          'circuit_open',
        ]),
      );
    });
  });
});
