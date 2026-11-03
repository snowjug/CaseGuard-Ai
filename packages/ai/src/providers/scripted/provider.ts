import type { AgentName } from '@caseguard/schemas';
import { ProviderError } from '../../errors';
import {
  systemClock,
  type Clock,
  type FinishReason,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelUsage,
  type ProviderDescriptor,
  type Sleep,
} from '../../types';
import { abortableSleep, createDeadline } from '../../util/abort';
import { parseModelJson } from '../../util/json';
import { estimateTokens } from '../../util/text';

/** The model name every scripted reply carries. It is clearly not a real deployment. */
export const SCRIPTED_MODEL = 'scripted-test-model';

export const SCRIPTED_VALIDATION_NOTE =
  'Test-only provider that replays a stated script. Every reply comes from that script, so nothing it returns says anything about the quality of a real model, and no real model was called.';

/** A failure the script injects instead of (or before) a reply. */
export type ScriptFailure =
  /** A reply that is not valid JSON. */
  | { kind: 'malformed_json' }
  /** The reply, cut off before it ends, with finish reason `length`. */
  | { kind: 'truncated' }
  /** Valid JSON of the wrong shape. */
  | { kind: 'schema_violation' }
  /** The provider gives up waiting. */
  | { kind: 'timeout' }
  /** HTTP 429. With `times`, the first `times` attempts fail and the provider retries within `maxRetries`; without it every attempt fails. */
  | { kind: 'rate_limited'; retryAfterMs?: number; times?: number }
  /** HTTP 5xx. With `times`, the first `times` attempts fail and the provider retries within `maxRetries`; without it every attempt fails. */
  | { kind: 'server_error'; status?: number; times?: number }
  /** The content filter blocks the prompt. */
  | { kind: 'content_filter' };

export interface ScriptStep {
  /** The reply as a value; it goes through JSON like a real reply, so nothing is shared with the test. */
  output?: unknown;
  /** The reply as text instead (parsed like a real provider's: a markdown fence is tolerated, nothing else). */
  text?: string;
  /** A failure instead of a reply. A `truncated` or `malformed_json` failure uses `output` or `text` as its source. */
  fail?: ScriptFailure;
  /** Exact usage to report. Without it the usage is estimated from the characters of the request and the reply. */
  usage?: Partial<Pick<ModelUsage, 'promptTokens' | 'completionTokens' | 'cachedTokens'>>;
  /** Waits before answering. The wait ends at once when the request is cancelled and fails when its deadline passes. */
  delayMs?: number;
  finishReason?: FinishReason;
}

/** One step, or a function of the request and the number of calls made for this agent so far (from 0). */
export type ScriptEntry = ScriptStep | ((request: ModelRequest, call: number) => ScriptStep);

/**
 * What to say, by agent. A single entry answers every call of that agent; a list is played in order and its last entry
 * repeats. An agent with no entry fails with `unsupported_task`, so a test never gets an answer it did not write.
 */
export type Script = Partial<Record<AgentName, ScriptEntry | readonly ScriptEntry[]>>;

export interface ScriptedProviderOptions {
  script: Script;
  /**
   * The provider is for local, test and CI runtimes only. The factory sets this to true only for a runtime that is not
   * deployed; constructed without it, the provider refuses to exist.
   */
  allowScripted: boolean;
  /** Replaces the real wait, so a test controls time. */
  sleep?: Sleep;
  clock?: Clock;
}

/** What one call did, for assertions. Never persisted, and never holds the prompt. */
export interface ScriptedCall {
  agent: AgentName;
  /** Zero-based number of this call among the calls for the same agent. */
  call: number;
  requestId: string;
  tenantId: string;
  model: string | null;
  /** HTTP attempts made inside the call (1 + transport retries). */
  attempts: number;
  promptTokens: number;
  completionTokens: number;
  outcome: 'reply' | 'error';
  /** The error code when the call failed. */
  errorCode: string | null;
}

const asList = (entry: ScriptEntry | readonly ScriptEntry[]): readonly ScriptEntry[] =>
  Array.isArray(entry) ? (entry as readonly ScriptEntry[]) : [entry as ScriptEntry];

const MALFORMED_TEXT = '{"signals": [{"id": "s1", "type": "signal", "statement": "';
const SCHEMA_VIOLATION = { signals: 'not a list', result: 7 };

/**
 * A provider that plays back a script. It exists to test the layers around a model (validation, policy, budgets,
 * cancellation, caching) without a model: it is `simulated`, its model is `scripted-test-model`, and it can fail in the
 * ways a remote model does (malformed or truncated JSON, a reply of the wrong shape, a timeout, 429, 5xx, a content
 * filter, a delay that can be cancelled). It makes no network call and reads nothing but its script.
 *
 * It must never serve a deployed runtime: the configuration loader refuses `AI_PROVIDER=scripted` there, and the
 * constructor refuses to build without `allowScripted`.
 */
export class ScriptedProvider implements ModelProvider {
  readonly kind = 'scripted' as const;
  readonly simulated = true;
  readonly defaultModel = SCRIPTED_MODEL;
  /** Every request, in order (the prompts included: this is a test double). */
  readonly requests: ModelRequest[] = [];
  readonly calls: ScriptedCall[] = [];
  private readonly counters = new Map<AgentName, number>();
  private readonly sleep: Sleep;
  private readonly clock: Clock;
  private readonly script: Script;

  constructor(options: ScriptedProviderOptions) {
    if (options.allowScripted !== true) {
      throw new ProviderError(
        'not_configured',
        'The scripted provider is for local, test and CI runtimes only and has to be enabled explicitly.',
      );
    }
    this.script = options.script;
    this.sleep = options.sleep ?? abortableSleep;
    this.clock = options.clock ?? systemClock;
  }

  describe(): ProviderDescriptor {
    return {
      kind: 'scripted',
      simulated: true,
      model: SCRIPTED_MODEL,
      configured: true,
      validationNote: SCRIPTED_VALIDATION_NOTE,
    };
  }

  /** Exact totals of what was asked and answered so far. */
  totals(): { calls: number; attempts: number; promptTokens: number; completionTokens: number } {
    return this.calls.reduce(
      (sum, c) => ({
        calls: sum.calls + 1,
        attempts: sum.attempts + c.attempts,
        promptTokens: sum.promptTokens + c.promptTokens,
        completionTokens: sum.completionTokens + c.completionTokens,
      }),
      { calls: 0, attempts: 0, promptTokens: 0, completionTokens: 0 },
    );
  }

  private stepFor(request: ModelRequest, call: number): ScriptStep {
    const entry = this.script[request.agent];
    if (entry === undefined) {
      throw new ProviderError(
        'unsupported_task',
        `The script has no entry for the ${request.agent} agent.`,
      );
    }
    const list = asList(entry);
    const chosen = list[Math.min(call, list.length - 1)];
    if (chosen === undefined) {
      throw new ProviderError('unsupported_task', 'The script entry for this agent is empty.');
    }
    return typeof chosen === 'function' ? chosen(request, call) : chosen;
  }

  private record(
    request: ModelRequest,
    call: number,
    facts: Pick<
      ScriptedCall,
      'attempts' | 'promptTokens' | 'completionTokens' | 'outcome' | 'errorCode'
    >,
  ): void {
    this.calls.push({
      agent: request.agent,
      call,
      requestId: request.requestId,
      tenantId: request.tenantId,
      model: request.model,
      ...facts,
    });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const started = this.clock.nowMs();
    const call = this.counters.get(request.agent) ?? 0;
    this.counters.set(request.agent, call + 1);
    this.requests.push(request);
    const promptTokens = estimateTokens(request.messages.map((m) => m.content).join('\n'));
    const fail = (error: ProviderError, attempts = 1): never => {
      this.record(request, call, {
        attempts,
        promptTokens,
        completionTokens: 0,
        outcome: 'error',
        errorCode: error.code,
      });
      throw error;
    };

    if (request.signal?.aborted)
      return fail(new ProviderError('cancelled', 'The request was cancelled.'));
    let step: ScriptStep;
    try {
      step = this.stepFor(request, call);
    } catch (error) {
      return fail(
        error instanceof ProviderError
          ? error
          : new ProviderError('unsupported_task', 'The script failed.'),
      );
    }

    if (step.delayMs !== undefined && step.delayMs > 0) {
      const deadline = createDeadline(request.timeoutMs, request.signal);
      try {
        await this.sleep(step.delayMs, deadline.signal);
      } catch {
        if (deadline.cancelled())
          return fail(new ProviderError('cancelled', 'The request was cancelled.'));
        return fail(
          new ProviderError('timeout', `The model did not respond within ${request.timeoutMs} ms.`),
        );
      } finally {
        deadline.dispose();
      }
    }

    const failure = step.fail;
    let attempts = 1;
    if (failure !== undefined) {
      const failing = this.transportFailure(failure, request.maxRetries ?? 0);
      if (failing !== null) return fail(failing.error, failing.attempts);
      attempts =
        failure.kind === 'rate_limited' || failure.kind === 'server_error'
          ? (failure.times ?? 1) + 1
          : 1;
    }

    const source = step.text ?? (step.output === undefined ? null : JSON.stringify(step.output));
    let text: string | null = source;
    let finishReason: FinishReason = step.finishReason ?? 'stop';
    if (failure?.kind === 'malformed_json') text = MALFORMED_TEXT;
    else if (failure?.kind === 'schema_violation') text = JSON.stringify(SCHEMA_VIOLATION);
    else if (failure?.kind === 'truncated') {
      text = (source ?? '{}').slice(0, Math.max(1, Math.floor((source ?? '{}').length * 0.6)));
      finishReason = 'length';
    }
    if (failure?.kind === 'content_filter') {
      return fail(
        new ProviderError('content_filtered', 'The prompt was blocked by the content filter.'),
      );
    }
    const parsed = text === null ? null : parseModelJson(text);
    const completionTokens = step.usage?.completionTokens ?? estimateTokens(text ?? '');
    const usage: ModelUsage = {
      promptTokens: step.usage?.promptTokens ?? promptTokens,
      completionTokens,
      cachedTokens: step.usage?.cachedTokens ?? 0,
      totalTokens: (step.usage?.promptTokens ?? promptTokens) + completionTokens,
      source: step.usage === undefined ? 'estimated' : 'measured',
    };
    this.record(request, call, {
      attempts,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      outcome: 'reply',
      errorCode: null,
    });
    return {
      output: parsed?.ok ? parsed.value : undefined,
      outputText: text,
      parseError:
        parsed === null ? 'The model returned no content.' : parsed.ok ? null : parsed.error,
      usage,
      model: SCRIPTED_MODEL,
      provider: 'scripted',
      latencyMs: Math.max(0, this.clock.nowMs() - started, step.delayMs ?? 0),
      simulated: true,
      finishReason,
      retries: attempts - 1,
      attempts,
    };
  }

  /**
   * The failures that end the call. A rate limit or server error with `times` fails that many attempts and then lets
   * the call through, as long as the retries the request allows are enough; otherwise the call fails after
   * `maxRetries + 1` attempts. Without `times` every attempt fails, so the call fails after `maxRetries + 1` attempts
   * (one when the request allows no retry).
   */
  private transportFailure(
    failure: ScriptFailure,
    maxRetries: number,
  ): { error: ProviderError; attempts: number } | null {
    switch (failure.kind) {
      case 'timeout':
        return {
          error: new ProviderError('timeout', 'The model did not respond in time.'),
          attempts: 1,
        };
      case 'rate_limited': {
        const failing = failure.times ?? Number.MAX_SAFE_INTEGER;
        if (failing <= maxRetries) return null;
        return {
          error: new ProviderError(
            'rate_limited',
            'The model service rate limit was reached (HTTP 429).',
            {
              status: 429,
              retryAfterMs: failure.retryAfterMs ?? null,
              attempts: Math.min(failing, maxRetries + 1),
            },
          ),
          attempts: Math.min(failing, maxRetries + 1),
        };
      }
      case 'server_error': {
        const failing = failure.times ?? Number.MAX_SAFE_INTEGER;
        if (failing <= maxRetries) return null;
        return {
          error: new ProviderError('server_error', 'The model service returned a server error.', {
            status: failure.status ?? 500,
            attempts: Math.min(failing, maxRetries + 1),
          }),
          attempts: Math.min(failing, maxRetries + 1),
        };
      }
      default:
        return null;
    }
  }
}

/**
 * Builds the scripted provider for a test. Its name says what it is: it is exported from the package under this name
 * only, so that no code can pick it up by accident.
 */
export function createScriptedTestProvider(options: ScriptedProviderOptions): ScriptedProvider {
  return new ScriptedProvider(options);
}
