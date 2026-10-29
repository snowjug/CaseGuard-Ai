import type {
  FinishReason,
  LogFields,
  Logger,
  MetricTags,
  Metrics,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelUsage,
  ProviderDescriptor,
  ProviderError,
} from '../src';
import { parseModelJson } from '../src/util/json';

/** Mutable clock so tests control time (breaker resets, TTLs, day roll-over). */
export class FakeClock {
  constructor(public ms = Date.parse('2026-10-29T12:00:00.000Z')) {}

  nowMs(): number {
    return this.ms;
  }

  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
}

export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  fields: LogFields;
  message: string;
}

export function capturingLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const at =
    (level: LogEntry['level']) =>
    (fields: LogFields, message: string): void => {
      entries.push({ level, fields, message });
    };
  return { entries, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

export interface MetricEntry {
  kind: 'increment' | 'observe' | 'gauge';
  name: string;
  value: number;
  tags: MetricTags;
}

export function capturingMetrics(): Metrics & {
  entries: MetricEntry[];
  sum: (name: string, tags?: Partial<Record<string, string>>) => number;
} {
  const entries: MetricEntry[] = [];
  const add =
    (kind: MetricEntry['kind']) =>
    (name: string, value = 1, tags: MetricTags = {}): void => {
      entries.push({ kind, name, value, tags });
    };
  return {
    entries,
    increment: add('increment'),
    observe: add('observe'),
    gauge: add('gauge'),
    sum: (name, tags = {}) =>
      entries
        .filter((e) => e.name === name && Object.entries(tags).every(([k, v]) => e.tags[k] === v))
        .reduce((s, e) => s + e.value, 0),
  };
}

export interface ScriptReply {
  output?: unknown;
  /** Raw text instead of an object (parsed like a real provider would). */
  text?: string;
  error?: ProviderError;
  usage?: Partial<ModelUsage>;
  latencyMs?: number;
  finishReason?: FinishReason;
  retries?: number;
  attempts?: number;
  /** Runs before the reply (for example to cancel a signal mid-call). */
  before?: () => void;
}

export type ScriptStep = ScriptReply | ((request: ModelRequest, call: number) => ScriptReply);

/** A remote-looking provider whose answers are scripted by the test. */
export class ScriptedProvider implements ModelProvider {
  readonly kind = 'azure-openai' as const;
  readonly simulated = false;
  readonly defaultModel = 'scripted-deployment';
  readonly requests: ModelRequest[] = [];

  constructor(private readonly steps: readonly ScriptStep[]) {}

  describe(): ProviderDescriptor {
    return {
      kind: 'azure-openai',
      simulated: false,
      model: this.defaultModel,
      configured: true,
      validationNote: 'Scripted test provider.',
    };
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const call = this.requests.length;
    this.requests.push(request);
    const step = this.steps[Math.min(call, this.steps.length - 1)];
    if (step === undefined) throw new Error('ScriptedProvider has no steps');
    const reply = typeof step === 'function' ? step(request, call) : step;
    reply.before?.();
    if (reply.error) throw reply.error;
    const text = reply.text ?? (reply.output === undefined ? null : JSON.stringify(reply.output));
    const parsed = reply.text === undefined ? null : parseModelJson(reply.text);
    const usage: ModelUsage = {
      promptTokens: 1000,
      completionTokens: 200,
      cachedTokens: 0,
      totalTokens: 1200,
      source: 'measured',
      ...reply.usage,
    };
    return {
      output: parsed ? (parsed.ok ? parsed.value : undefined) : reply.output,
      outputText: text,
      parseError: parsed && !parsed.ok ? parsed.error : null,
      usage,
      model: 'scripted-model-2026',
      provider: 'azure-openai',
      latencyMs: reply.latencyMs ?? 25,
      simulated: false,
      finishReason: reply.finishReason ?? 'stop',
      retries: reply.retries ?? 0,
      attempts: reply.attempts ?? 1,
    };
  }
}
