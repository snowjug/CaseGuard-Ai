import { describe, expect, it } from 'vitest';
import {
  SCRIPTED_MODEL,
  SCRIPTED_VALIDATION_NOTE,
  ScriptedTestProvider,
  createScriptedTestProvider,
  type AgentTask,
  type ModelRequest,
  type Script,
} from '../../src';
import { ProviderError } from '../../src/errors';

const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  requestId: 'req_1',
  tenantId: 'tenant_a',
  agent: 'case_reasoner',
  messages: [
    { role: 'system', content: 'You are a careful reviewer.' },
    { role: 'user', content: 'Review this case.' },
  ],
  structuredOutput: { name: 'x', schema: {}, strict: true },
  maxOutputTokens: 1000,
  temperature: 0,
  timeoutMs: 1000,
  model: 'gpt-test',
  task: {} as unknown as AgentTask,
  ...over,
});

const make = (
  script: Script,
  extra: { sleep?: (ms: number, signal?: AbortSignal) => Promise<void> } = {},
) => createScriptedTestProvider({ script, allowScripted: true, ...extra });

const failure = async (provider: ScriptedTestProvider, req = request()): Promise<ProviderError> => {
  try {
    await provider.complete(req);
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    return error as ProviderError;
  }
  throw new Error('expected the call to fail');
};

describe('scripted test provider', () => {
  describe('what it is', () => {
    it('refuses to be built unless it was explicitly allowed', () => {
      expect(() => new ScriptedTestProvider({ script: {}, allowScripted: false })).toThrowError(
        /local, test and CI/,
      );
      expect(
        () =>
          new ScriptedTestProvider({ script: {}, allowScripted: undefined as unknown as boolean }),
      ).toThrowError(ProviderError);
    });

    it('says plainly that it is simulated and that nothing it returns says anything about a real model', () => {
      const provider = make({});
      expect(provider.kind).toBe('scripted');
      expect(provider.simulated).toBe(true);
      expect(provider.describe()).toEqual({
        kind: 'scripted',
        simulated: true,
        model: SCRIPTED_MODEL,
        configured: true,
        validationNote: SCRIPTED_VALIDATION_NOTE,
      });
      expect(SCRIPTED_VALIDATION_NOTE).toMatch(/no real model was called/i);
      expect(SCRIPTED_MODEL).toBe('scripted-test-model');
    });

    it('marks every reply simulated, whatever deployment the request asked for', async () => {
      const response = await make({ case_reasoner: { output: { ok: true } } }).complete(request());
      expect(response).toMatchObject({
        provider: 'scripted',
        simulated: true,
        model: SCRIPTED_MODEL,
      });
    });
  });

  describe('replies', () => {
    it('plays a value through JSON, so a test and the provider share nothing', async () => {
      const output = { items: [{ n: 1 }] };
      const response = await make({ case_reasoner: { output } }).complete(request());
      expect(response.output).toEqual(output);
      expect(response.output).not.toBe(output);
      expect(response.parseError).toBeNull();
      expect(response.finishReason).toBe('stop');
      expect(response.outputText).toBe(JSON.stringify(output));
    });

    it('plays a text like a real reply: a markdown fence is tolerated, nothing else', async () => {
      const fenced = await make({ case_reasoner: { text: '```json\n{"a":1}\n```' } }).complete(
        request(),
      );
      expect(fenced.output).toEqual({ a: 1 });
      const prose = await make({ case_reasoner: { text: 'Here you go: {"a":1}' } }).complete(
        request(),
      );
      expect(prose.output).toBeUndefined();
      expect(prose.parseError).not.toBeNull();
    });

    it('plays a list in order and repeats its last entry', async () => {
      const provider = make({ case_reasoner: [{ output: { n: 1 } }, { output: { n: 2 } }] });
      const seen: unknown[] = [];
      for (let i = 0; i < 4; i++) seen.push((await provider.complete(request())).output);
      expect(seen).toEqual([{ n: 1 }, { n: 2 }, { n: 2 }, { n: 2 }]);
    });

    it('counts the calls of each agent on its own, and hands a function entry the request and the call number', async () => {
      const calls: [string, number][] = [];
      const provider = make({
        case_reasoner: (req, call) => {
          calls.push([req.agent, call]);
          return { output: { call } };
        },
        case_critic: (req, call) => {
          calls.push([req.agent, call]);
          return { output: { call } };
        },
      });
      await provider.complete(request());
      await provider.complete(request({ agent: 'case_critic' }));
      await provider.complete(request());
      expect(calls).toEqual([
        ['case_reasoner', 0],
        ['case_critic', 0],
        ['case_reasoner', 1],
      ]);
    });

    it('fails with unsupported_task for an agent with no entry, so a test never gets an answer it did not write', async () => {
      const error = await failure(
        make({ case_reasoner: { output: {} } }),
        request({ agent: 'case_critic' }),
      );
      expect(error.code).toBe('unsupported_task');
    });

    it('fails with unsupported_task for an empty list', async () => {
      const error = await failure(make({ case_reasoner: [] }));
      expect(error.code).toBe('unsupported_task');
    });
  });

  describe('usage', () => {
    it('reports the exact usage a step states, as measured', async () => {
      const response = await make({
        case_reasoner: {
          output: {},
          usage: { promptTokens: 1234, completionTokens: 56, cachedTokens: 10 },
        },
      }).complete(request());
      expect(response.usage).toEqual({
        promptTokens: 1234,
        completionTokens: 56,
        cachedTokens: 10,
        totalTokens: 1290,
        source: 'measured',
      });
    });

    it('estimates it from the text when a step states none, and says so', async () => {
      const response = await make({ case_reasoner: { output: { a: 'b' } } }).complete(request());
      expect(response.usage.source).toBe('estimated');
      expect(response.usage.promptTokens).toBeGreaterThan(0);
      expect(response.usage.completionTokens).toBeGreaterThan(0);
      expect(response.usage.totalTokens).toBe(
        response.usage.promptTokens + response.usage.completionTokens,
      );
    });

    it('keeps exact totals and a record of every call, without the prompts', async () => {
      const provider = make({
        case_reasoner: { output: {}, usage: { promptTokens: 100, completionTokens: 20 } },
        case_critic: { fail: { kind: 'timeout' } },
      });
      await provider.complete(request({ requestId: 'r1' }));
      await provider.complete(request({ requestId: 'r2' }));
      await failure(provider, request({ agent: 'case_critic', requestId: 'r3' }));
      const totals = provider.totals();
      expect(totals.calls).toBe(3);
      expect(totals.completionTokens).toBe(40);
      expect(totals.promptTokens).toBeGreaterThan(200);
      expect(provider.requests.map((r) => r.requestId)).toEqual(['r1', 'r2', 'r3']);
      expect(provider.calls.map((c) => [c.agent, c.call, c.outcome, c.errorCode])).toEqual([
        ['case_reasoner', 0, 'reply', null],
        ['case_reasoner', 1, 'reply', null],
        ['case_critic', 0, 'error', 'timeout'],
      ]);
      expect(JSON.stringify(provider.calls)).not.toContain('careful reviewer');
    });
  });

  describe('failures it can play', () => {
    it('a reply that is not JSON', async () => {
      const response = await make({
        case_reasoner: { output: { a: 1 }, fail: { kind: 'malformed_json' } },
      }).complete(request());
      expect(response.output).toBeUndefined();
      expect(response.parseError).not.toBeNull();
      expect(response.outputText).not.toBeNull();
      expect(() => {
        JSON.parse(response.outputText ?? '');
      }).toThrow();
    });

    it('a reply that is cut off, with finish reason length', async () => {
      const response = await make({
        case_reasoner: {
          output: { items: ['one', 'two', 'three', 'four', 'five'] },
          fail: { kind: 'truncated' },
        },
      }).complete(request());
      expect(response.finishReason).toBe('length');
      expect(response.output).toBeUndefined();
      expect((response.outputText ?? '').length).toBeLessThan(
        JSON.stringify({ items: ['one', 'two', 'three', 'four', 'five'] }).length,
      );
    });

    it('JSON of the wrong shape', async () => {
      const response = await make({
        case_reasoner: { fail: { kind: 'schema_violation' } },
      }).complete(request());
      expect(response.output).toEqual({ signals: 'not a list', result: 7 });
      expect(response.parseError).toBeNull();
    });

    it('a timeout', async () => {
      const error = await failure(make({ case_reasoner: { fail: { kind: 'timeout' } } }));
      expect(error.code).toBe('timeout');
      expect(error.retryable).toBe(false);
    });

    it('a content filter block', async () => {
      const error = await failure(make({ case_reasoner: { fail: { kind: 'content_filter' } } }));
      expect(error.code).toBe('content_filtered');
    });

    it('a rate limit at once: HTTP 429, one attempt, the wait the service asked for', async () => {
      const error = await failure(
        make({ case_reasoner: { fail: { kind: 'rate_limited', retryAfterMs: 2000 } } }),
      );
      expect(error).toMatchObject({
        code: 'rate_limited',
        status: 429,
        retryAfterMs: 2000,
        attempts: 1,
      });
      expect(error.retryable).toBe(true);
    });

    it('a server error at once: the status it names', async () => {
      const error = await failure(
        make({ case_reasoner: { fail: { kind: 'server_error', status: 503 } } }),
      );
      expect(error).toMatchObject({ code: 'server_error', status: 503, attempts: 1 });
    });

    it('transport failures that are retried within the budget of the request, then a reply', async () => {
      const provider = make({
        case_reasoner: { output: { ok: true }, fail: { kind: 'server_error', times: 2 } },
      });
      const response = await provider.complete(request({ maxRetries: 3 }));
      expect(response).toMatchObject({ output: { ok: true }, attempts: 3, retries: 2 });
      expect(provider.calls[0]).toMatchObject({ attempts: 3, outcome: 'reply' });
    });

    it('transport failures that outlast the budget: the call fails after the allowed attempts', async () => {
      const provider = make({
        case_reasoner: { output: {}, fail: { kind: 'rate_limited', times: 5 } },
      });
      const error = await failure(provider, request({ maxRetries: 2 }));
      expect(error).toMatchObject({ code: 'rate_limited', attempts: 3 });
      expect(provider.calls[0]).toMatchObject({
        attempts: 3,
        outcome: 'error',
        errorCode: 'rate_limited',
      });
    });
  });

  describe('time and cancellation', () => {
    it('waits through the injected sleep and reports at least that latency', async () => {
      const waits: number[] = [];
      const provider = make(
        { case_reasoner: { output: {}, delayMs: 700 } },
        {
          sleep: async (ms) => {
            waits.push(ms);
          },
        },
      );
      const response = await provider.complete(request());
      expect(waits).toEqual([700]);
      expect(response.latencyMs).toBeGreaterThanOrEqual(700);
    });

    it('fails with a timeout when the wait outlasts the deadline of the request', async () => {
      const provider = make({ case_reasoner: { output: {}, delayMs: 10_000 } });
      const started = Date.now();
      const error = await failure(provider, request({ timeoutMs: 30 }));
      expect(error.code).toBe('timeout');
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it('stops waiting the moment the request is cancelled, and fails as cancelled', async () => {
      const controller = new AbortController();
      const provider = make({ case_reasoner: { output: {}, delayMs: 10_000 } });
      const pending = failure(provider, request({ signal: controller.signal, timeoutMs: 60_000 }));
      setTimeout(() => controller.abort(), 20);
      const started = Date.now();
      const error = await pending;
      expect(error.code).toBe('cancelled');
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it('fails as cancelled when the request was cancelled before the call', async () => {
      const controller = new AbortController();
      controller.abort();
      const provider = make({ case_reasoner: { output: {} } });
      const error = await failure(provider, request({ signal: controller.signal }));
      expect(error.code).toBe('cancelled');
      expect(provider.calls[0]).toMatchObject({ outcome: 'error', errorCode: 'cancelled' });
    });
  });
});
