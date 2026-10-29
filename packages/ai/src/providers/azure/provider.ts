import { ProviderError } from '../../errors';
import {
  noopLogger,
  noopMetrics,
  systemClock,
  type Clock,
  type LogFields,
  type Logger,
  type Metrics,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ProviderDescriptor,
  type RandomSource,
  type Sleep,
  type TokenCredential,
} from '../../types';
import { abortableSleep, createDeadline, type Deadline } from '../../util/abort';
import { createSecretScrubber } from '../../util/redact';
import {
  assertDeployment,
  chatCompletionsUrl,
  parseAzureError,
  parseEndpoint,
  readBodyCapped,
  retryAfterMs,
  type AzureErrorBody,
} from './http';
import { parseChatCompletion } from './response';

export const AZURE_OPENAI_SCOPE = 'https://cognitiveservices.azure.com/.default';

export const AZURE_VALIDATION_NOTE =
  'Implemented against the Azure OpenAI chat-completions REST shape; validated against a local mock server only. It has not been exercised against real Azure OpenAI.';

export type AzureAuth =
  | { kind: 'managed-identity'; credential: TokenCredential; scope?: string }
  | { kind: 'api-key'; apiKey: string };

export interface AzureRetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  /** A server-requested wait longer than this fails fast instead of sleeping. */
  maxRetryAfterMs: number;
}

export interface AzureOpenAiProviderOptions {
  /** Bare origin, e.g. `https://my-resource.openai.azure.com`. */
  endpoint: string;
  deployment: string;
  apiVersion: string;
  auth: AzureAuth;
  /** Explicit opt-in for api-key auth, which is meant for local experiments only. */
  allowApiKey?: boolean;
  fetch?: typeof fetch;
  clock?: Clock;
  sleep?: Sleep;
  random?: RandomSource;
  logger?: Logger;
  metrics?: Metrics;
  maxRetries?: number;
  retry?: Partial<AzureRetryPolicy>;
  /** Reasoning models require `max_completion_tokens`. */
  tokenLimitParameter?: 'max_tokens' | 'max_completion_tokens';
  maxResponseBytes?: number;
}

const DEFAULT_RETRY: AzureRetryPolicy = {
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  maxRetryAfterMs: 15_000,
};
const TOKEN_REFRESH_SKEW_MS = 120_000;
const ERROR_BODY_LIMIT = 65_536;

const withAttempts = (error: ProviderError, attempts: number): ProviderError =>
  new ProviderError(error.code, error.message, {
    status: error.status,
    retryAfterMs: error.retryAfterMs,
    attempts,
  });

/**
 * Azure OpenAI chat-completions client implemented with `fetch`: managed-identity bearer tokens
 * (or an api-key for local experiments), strict JSON-schema structured output, content-filter and
 * finish-reason handling, measured token usage, bounded retries with jittered backoff that honour
 * Retry-After, a total deadline and cancellation. It sends no tools and follows no redirects.
 *
 * Validated only against a local mock server; never exercised against real Azure.
 */
export class AzureOpenAiProvider implements ModelProvider {
  readonly kind = 'azure-openai' as const;
  readonly simulated = false;
  readonly defaultModel: string;
  private readonly origin: string;
  private readonly apiVersion: string;
  private readonly auth: AzureAuth;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: Clock;
  private readonly sleep: Sleep;
  private readonly random: RandomSource;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly maxRetries: number;
  private readonly retry: AzureRetryPolicy;
  private readonly tokenParam: 'max_tokens' | 'max_completion_tokens';
  private readonly maxResponseBytes: number;
  private cachedToken: { token: string; expiresAtMs: number } | null = null;

  constructor(options: AzureOpenAiProviderOptions) {
    if (options.auth.kind === 'api-key' && options.allowApiKey !== true) {
      throw new ProviderError(
        'not_configured',
        'api-key authentication is for local experiments only and must be enabled explicitly.',
      );
    }
    if (options.auth.kind === 'api-key' && options.auth.apiKey.length === 0) {
      throw new ProviderError('not_configured', 'The Azure OpenAI api key is empty.');
    }
    this.origin = parseEndpoint(options.endpoint);
    this.defaultModel = assertDeployment(options.deployment);
    this.apiVersion = options.apiVersion;
    this.auth = options.auth;
    this.fetchImpl = options.fetch ?? fetch;
    this.clock = options.clock ?? systemClock;
    this.sleep = options.sleep ?? abortableSleep;
    this.random = options.random ?? Math.random;
    this.logger = options.logger ?? noopLogger;
    this.metrics = options.metrics ?? noopMetrics;
    this.maxRetries = options.maxRetries ?? 2;
    this.retry = { ...DEFAULT_RETRY, ...options.retry };
    this.tokenParam = options.tokenLimitParameter ?? 'max_tokens';
    this.maxResponseBytes = options.maxResponseBytes ?? 2_000_000;
  }

  describe(): ProviderDescriptor {
    return {
      kind: 'azure-openai',
      simulated: false,
      model: this.defaultModel,
      configured: true,
      validationNote: AZURE_VALIDATION_NOTE,
    };
  }

  private scrub(text: string): string {
    const secrets: string[] = [];
    if (this.auth.kind === 'api-key') secrets.push(this.auth.apiKey);
    if (this.cachedToken) secrets.push(this.cachedToken.token);
    return createSecretScrubber(secrets)(text);
  }

  private logWarn(fields: LogFields, message: string): void {
    const safe = Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, typeof v === 'string' ? this.scrub(v) : v]),
    );
    this.logger.warn(safe, this.scrub(message));
  }

  private async bearer(signal: AbortSignal): Promise<string> {
    if (this.auth.kind !== 'managed-identity')
      throw new Error('Bearer tokens are only used with managed identity');
    const now = this.clock.nowMs();
    if (this.cachedToken && this.cachedToken.expiresAtMs - now > TOKEN_REFRESH_SKEW_MS) {
      return this.cachedToken.token;
    }
    let token: Awaited<ReturnType<TokenCredential['getToken']>>;
    try {
      token = await this.auth.credential.getToken(this.auth.scope ?? AZURE_OPENAI_SCOPE, {
        abortSignal: signal,
      });
    } catch {
      if (signal.aborted)
        throw new ProviderError('cancelled', 'The request was cancelled while acquiring a token.');
      throw new ProviderError(
        'unauthorized',
        'An Azure OpenAI access token could not be acquired.',
      );
    }
    if (!token || token.token.length === 0) {
      throw new ProviderError(
        'unauthorized',
        'An Azure OpenAI access token could not be acquired.',
      );
    }
    this.cachedToken = { token: token.token, expiresAtMs: token.expiresOnTimestamp };
    return token.token;
  }

  private async headers(signal: AbortSignal): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'caseguard-ai/0.1',
    };
    if (this.auth.kind === 'api-key') headers['api-key'] = this.auth.apiKey;
    else headers.authorization = `Bearer ${await this.bearer(signal)}`;
    return headers;
  }

  private buildBody(request: ModelRequest): string {
    return JSON.stringify({
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      [this.tokenParam]: request.maxOutputTokens,
      temperature: request.temperature,
      stream: false,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: request.structuredOutput.name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64),
          strict: request.structuredOutput.strict,
          schema: request.structuredOutput.schema,
        },
      },
    });
  }

  private errorForStatus(status: number, body: AzureErrorBody, headers: Headers): ProviderError {
    const code = body.code ?? body.innerCode;
    const suffix = code ? ` (${code})` : '';
    const options = { status, retryAfterMs: retryAfterMs(headers, this.clock.nowMs()) };
    if (
      status === 400 &&
      (body.code === 'content_filter' || body.innerCode === 'ResponsibleAIPolicyViolation')
    ) {
      return new ProviderError(
        'content_filtered',
        'The prompt was blocked by the Azure OpenAI content filter.',
        options,
      );
    }
    if (status === 401)
      return new ProviderError(
        'unauthorized',
        `Azure OpenAI rejected the credentials (HTTP 401)${suffix}.`,
        options,
      );
    if (status === 403)
      return new ProviderError(
        'forbidden',
        `Azure OpenAI denied access (HTTP 403)${suffix}.`,
        options,
      );
    if (status === 429)
      return new ProviderError(
        'rate_limited',
        `Azure OpenAI rate limit reached (HTTP 429)${suffix}.`,
        options,
      );
    if (status === 408 || status >= 500) {
      return new ProviderError(
        'server_error',
        `Azure OpenAI returned a server error (HTTP ${status})${suffix}.`,
        options,
      );
    }
    return new ProviderError(
      'bad_request',
      `Azure OpenAI rejected the request (HTTP ${status})${suffix}.`,
      options,
    );
  }

  private async attempt(
    url: string,
    body: string,
    deployment: string,
    promptText: string,
    deadline: Deadline,
  ): Promise<ReturnType<typeof parseChatCompletion>> {
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: await this.headers(deadline.signal),
      body,
      signal: deadline.signal,
      redirect: 'error',
    });
    if (response.status >= 200 && response.status < 300) {
      return parseChatCompletion(
        await readBodyCapped(response, this.maxResponseBytes),
        deployment,
        promptText,
      );
    }
    let errorText = '';
    try {
      errorText = await readBodyCapped(response, ERROR_BODY_LIMIT);
    } catch (error) {
      if (!(error instanceof ProviderError && error.code === 'response_too_large')) throw error;
    }
    throw this.errorForStatus(response.status, parseAzureError(errorText), response.headers);
  }

  private classify(error: unknown, deadline: Deadline, timeoutMs: number): ProviderError {
    if (deadline.cancelled()) return new ProviderError('cancelled', 'The request was cancelled.');
    if (deadline.timedOut()) {
      return new ProviderError('timeout', `The model did not respond within ${timeoutMs} ms.`);
    }
    if (error instanceof ProviderError) return error;
    return new ProviderError(
      'network',
      'The request to Azure OpenAI failed before a response was received.',
    );
  }

  /** Wait before the next attempt, or null when the server asked for longer than we allow. */
  private backoffDelay(failure: ProviderError, retries: number): number | null {
    if (failure.retryAfterMs !== null) {
      if (failure.retryAfterMs > this.retry.maxRetryAfterMs) return null;
      return Math.round(failure.retryAfterMs * (1 + this.random() * 0.1));
    }
    const ceiling = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** retries);
    return Math.round(ceiling * (0.5 + this.random() * 0.5));
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const started = this.clock.nowMs();
    const deployment = request.model === null ? this.defaultModel : assertDeployment(request.model);
    const url = chatCompletionsUrl(this.origin, deployment, this.apiVersion);
    const body = this.buildBody(request);
    const promptText = request.messages.map((m) => m.content).join('\n');
    const maxRetries = request.maxRetries ?? this.maxRetries;
    const deadline = createDeadline(request.timeoutMs, request.signal);
    let attempts = 0;
    let retries = 0;
    let tokenRefreshed = false;
    try {
      for (;;) {
        attempts++;
        try {
          const parsed = await this.attempt(url, body, deployment, promptText, deadline);
          this.metrics.observe('ai.provider.attempts', attempts, { provider: 'azure-openai' });
          return {
            output: parsed.output,
            outputText: parsed.outputText,
            parseError: parsed.parseError,
            usage: parsed.usage,
            model: parsed.model,
            provider: 'azure-openai',
            latencyMs: Math.max(0, this.clock.nowMs() - started),
            simulated: false,
            finishReason: parsed.finishReason,
            retries,
            attempts,
          };
        } catch (error) {
          const failure = this.classify(error, deadline, request.timeoutMs);
          if (
            failure.code === 'unauthorized' &&
            this.auth.kind === 'managed-identity' &&
            !tokenRefreshed
          ) {
            tokenRefreshed = true;
            this.cachedToken = null;
            retries++;
            continue;
          }
          if (!failure.retryable || retries >= maxRetries) throw withAttempts(failure, attempts);
          const delay = this.backoffDelay(failure, retries);
          const remaining = request.timeoutMs - (this.clock.nowMs() - started);
          if (delay === null || delay >= remaining) throw withAttempts(failure, attempts);
          this.logWarn(
            {
              event: 'ai.provider.retry',
              agent: request.agent,
              deployment,
              attempt: attempts,
              status: failure.status,
              code: failure.code,
              delayMs: delay,
            },
            'Retrying Azure OpenAI call',
          );
          this.metrics.increment('ai.provider.retry', 1, {
            provider: 'azure-openai',
            code: failure.code,
          });
          try {
            await this.sleep(delay, deadline.signal);
          } catch {
            throw withAttempts(this.classify(failure, deadline, request.timeoutMs), attempts);
          }
          retries++;
        }
      }
    } finally {
      deadline.dispose();
    }
  }
}
