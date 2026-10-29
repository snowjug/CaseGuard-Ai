import type { AgentName, ProviderKind } from '@caseguard/schemas';
import type { AgentTask } from './agents/tasks';

/** Injected time source (epoch milliseconds) so every timestamp and latency is reproducible. */
export interface Clock {
  nowMs(): number;
}

export const systemClock: Clock = { nowMs: () => Date.now() };

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Uniform random numbers in [0, 1); injected so retry jitter is deterministic in tests. */
export type RandomSource = () => number;

export interface IdGenerator {
  next(prefix: string): string;
}

export type LogFields = Readonly<Record<string, unknown>>;

/** Pino-compatible logging surface. The API layer wires the real logger (with redaction). */
export interface Logger {
  debug(fields: LogFields, message: string): void;
  info(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
  error(fields: LogFields, message: string): void;
}

export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export type MetricTags = Readonly<Record<string, string>>;

/** Minimal metrics sink; the API layer adapts it to the observability registry. */
export interface Metrics {
  increment(name: string, value?: number, tags?: MetricTags): void;
  observe(name: string, value: number, tags?: MetricTags): void;
  gauge(name: string, value: number, tags?: MetricTags): void;
}

export const noopMetrics: Metrics = {
  increment: () => undefined,
  observe: () => undefined,
  gauge: () => undefined,
};

export interface AccessToken {
  token: string;
  expiresOnTimestamp: number;
}

/** Structurally compatible with `@azure/identity` credentials (DefaultAzureCredential, managed identity). */
export interface TokenCredential {
  getToken(scope: string, options?: { abortSignal?: AbortSignal }): Promise<AccessToken | null>;
}

export interface InjectionIndicator {
  ruleId: string;
  severity: 'low' | 'medium' | 'high';
  /** Short excerpt of the offending text. */
  excerpt: string;
}

/** Detects instruction-like content inside untrusted text. */
export type InjectionScanner = (text: string) => readonly InjectionIndicator[];

/** Masks secret- and PII-like values before text leaves the process. */
export type Redactor = (text: string) => string;

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StructuredOutputSpec {
  name: string;
  /** JSON Schema (strict subset) the model must satisfy. */
  schema: Readonly<Record<string, unknown>>;
  strict: boolean;
}

export interface ModelRequest {
  requestId: string;
  tenantId: string;
  agent: AgentName;
  messages: readonly ModelMessage[];
  structuredOutput: StructuredOutputSpec;
  maxOutputTokens: number;
  temperature: number;
  /** Total deadline across all transport retries. */
  timeoutMs: number;
  /** Transport-level retry budget for this call (429/5xx/network); provider default when absent. */
  maxRetries?: number | undefined;
  /** Routed deployment/model name; null selects the provider default. */
  model: string | null;
  signal?: AbortSignal | undefined;
  /**
   * Typed task payload consumed ONLY by the deterministic provider. Remote providers serialise
   * `messages` and never receive this object.
   */
  task: AgentTask;
}

export type TokenSource = 'measured' | 'estimated';

export interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
  source: TokenSource;
}

export type FinishReason = 'stop' | 'length' | 'content_filter' | 'other';

export interface ModelResponse {
  /** Parsed JSON. `undefined` when the model returned text that is not valid JSON. */
  output: unknown;
  /** Raw model text (remote providers only). Never persisted unless the caller opts in. */
  outputText: string | null;
  parseError: string | null;
  usage: ModelUsage;
  model: string;
  provider: ProviderKind;
  latencyMs: number;
  simulated: boolean;
  finishReason: FinishReason;
  /** Transport-level retries (429/5xx/network) performed inside the provider. */
  retries: number;
  /** HTTP/model attempts performed for this call (1 + retries). */
  attempts: number;
}

export interface ProviderDescriptor {
  kind: ProviderKind;
  simulated: boolean;
  model: string;
  configured: boolean;
  /** Honest statement of what has and has not been validated against a live service. */
  validationNote: string;
}

export interface ModelProvider {
  readonly kind: ProviderKind;
  readonly simulated: boolean;
  readonly defaultModel: string;
  describe(): ProviderDescriptor;
  /** Throws `ProviderError` (sanitised, typed) on failure; never returns partial output. */
  complete(request: ModelRequest): Promise<ModelResponse>;
}
