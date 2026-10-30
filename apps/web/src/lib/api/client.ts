import {
  ProblemSchema,
  ROUTES,
  buildPath,
  buildQueryString,
  type RouteBody,
  type RouteId,
  type RouteParams,
  type RouteQuery,
  type RouteResponse,
  type RouteSpec,
} from '@caseguard/schemas';
import type { ValidationMode } from '../env';
import { ApiError, apiErrorFromProblem, type ApiIssue } from './errors';

/** Marks a key optional when its input type has no required fields (or is `undefined`), required otherwise. */
type Field<Key extends string, T> = [T] extends [undefined]
  ? { [P in Key]?: undefined }
  : object extends T
    ? { [P in Key]?: T }
    : { [P in Key]: T };

export interface CallOptions {
  /** Abort the request (TanStack Query passes its own signal). */
  signal?: AbortSignal | undefined;
  /** Supply a stable key for an idempotent write so a retry or double click cannot create twice. */
  idempotencyKey?: string | undefined;
  /** Overrides the default timeout. */
  timeoutMs?: number | undefined;
  /** Request body for multipart routes (`ingestion.previewFile`, `cases.createFromFile`). */
  formData?: FormData | undefined;
  /**
   * Overrides how many times an idempotent request is repeated after a transient failure (429 and 5xx included). Use
   * `0` where the caller shows the failure itself, for example a rate-limited earlier view with its own countdown.
   * Whatever the value, a `Retry-After` above 5 seconds is not waited for: the failure is thrown at once.
   */
  maxRetries?: number | undefined;
}

/** Typed input of `callApi`, derived from the route registry: params, query and body are required exactly when the route needs them. */
export type ApiInput<K extends RouteId> = Field<'params', RouteParams<K>> &
  Field<'query', RouteQuery<K>> &
  Field<'body', RouteBody<K>> &
  CallOptions;

/** The arguments after the route id: optional when nothing is required. */
export type ApiArgs<K extends RouteId> =
  object extends ApiInput<K> ? [input?: ApiInput<K>] : [input: ApiInput<K>];

export interface ApiClientDeps {
  fetch?: typeof fetch;
  /** Prefix of every request; empty means same origin (the browser calls `/api/v1/*`, Next rewrites to the API). */
  baseUrl?: string;
  /** Headers that identify the caller: `x-cg-persona` (development identity) or `Authorization: Bearer` (Entra). */
  getAuthHeaders?: () => Promise<Record<string, string>> | Record<string, string>;
  newCorrelationId?: () => string;
  newIdempotencyKey?: () => string;
  validation?: ValidationMode;
  /** Random source for sampled validation and retry jitter (injected for deterministic tests). */
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Default timeout in milliseconds (30 s). */
  timeoutMs?: number;
  /** Retries for idempotent requests (GET and keyed POST). Non-idempotent writes are never retried. */
  maxRetries?: number;
}

export interface ApiClient {
  call: <K extends RouteId>(routeId: K, ...args: ApiArgs<K>) => Promise<RouteResponse<K>>;
}

const uuid = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

const abortError = (signal?: AbortSignal): Error =>
  signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError');

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const SAMPLE_RATE = 0.1;
const DEFAULT_TIMEOUT_MS = 30_000;
/** A longer `Retry-After` is never slept through by a retry: the failure is thrown so the page can show a countdown. */
const MAX_RETRY_AFTER_MS = 5_000;

interface InternalInput {
  params?: Record<string, string | number> | undefined;
  query?: Record<string, unknown> | undefined;
  body?: unknown;
}

function zodIssues(error: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}): ApiIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * Creates the typed API client. Everything environment-specific (fetch, clock-free ids, randomness, sleep, identity)
 * is injected, so behaviour is deterministic under test and there is no hidden module state.
 */
export function createApiClient(deps: ApiClientDeps = {}): ApiClient {
  const fetchImpl = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const baseUrl = (deps.baseUrl ?? '').replace(/\/+$/, '');
  const newCorrelationId = deps.newCorrelationId ?? uuid;
  const newIdempotencyKey = deps.newIdempotencyKey ?? uuid;
  const validation = deps.validation ?? 'off';
  const random = deps.random ?? Math.random;
  const sleep = deps.sleep ?? defaultSleep;
  const defaultTimeout = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const call = async <K extends RouteId>(
    routeId: K,
    ...args: ApiArgs<K>
  ): Promise<RouteResponse<K>> => {
    const input = (args[0] ?? {}) as InternalInput & CallOptions;
    const route: RouteSpec = ROUTES[routeId];

    if (validation === 'always') validateRequest(routeId, route, input);

    const path = buildPath(route.path, input.params);
    const url = `${baseUrl}${path}${buildQueryString(input.query)}`;
    const correlationId = newCorrelationId();
    const idempotent = route.method === 'GET' || route.idempotent === true;
    const maxRetries = idempotent
      ? (input.maxRetries ?? deps.maxRetries ?? (route.method === 'GET' ? 2 : 1))
      : 0;
    const idempotencyKey = route.idempotent
      ? (input.idempotencyKey ?? newIdempotencyKey())
      : undefined;

    if (route.multipart && !input.formData) {
      throw new ApiError({
        status: 0,
        code: 'invalid_request',
        title: 'Missing upload',
        message: `${routeId} requires formData`,
      });
    }

    let attempt = 0;
    for (;;) {
      try {
        const headers = new Headers({
          accept: 'application/json',
          'x-correlation-id': correlationId,
        });
        if (idempotencyKey) headers.set('idempotency-key', idempotencyKey);
        const auth = await (deps.getAuthHeaders?.() ?? {});
        for (const [name, value] of Object.entries(auth)) headers.set(name, value);

        let body: BodyInit | undefined;
        if (route.multipart && input.formData) {
          body = input.formData;
        } else if (input.body !== undefined) {
          headers.set('content-type', 'application/json');
          body = JSON.stringify(input.body);
        }
        return await send<K>(
          url,
          { method: route.method, headers, body },
          route,
          correlationId,
          input,
          defaultTimeout,
        );
      } catch (error) {
        const retryable = error instanceof ApiError && error.isRetryable;
        if (!retryable || attempt >= maxRetries) throw error;
        if (error.retryAfterMs !== undefined && error.retryAfterMs > MAX_RETRY_AFTER_MS)
          throw error;
        const backoff = Math.min(2000, 250 * 2 ** attempt) * (0.75 + random() * 0.5);
        await sleep(error.retryAfterMs ?? backoff, input.signal);
        attempt += 1;
      }
    }
  };

  async function send<K extends RouteId>(
    url: string,
    init: RequestInit,
    route: RouteSpec,
    correlationId: string,
    input: CallOptions,
    timeoutMs: number,
  ): Promise<RouteResponse<K>> {
    const controller = new AbortController();
    let timedOut = false;
    const limit = input.timeoutMs ?? timeoutMs;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, limit);
    const onCallerAbort = (): void => controller.abort(input.signal?.reason);
    if (input.signal?.aborted) controller.abort(input.signal.reason);
    else input.signal?.addEventListener('abort', onCallerAbort, { once: true });

    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init,
        signal: controller.signal,
        credentials: 'same-origin',
      });
    } catch (error) {
      if (timedOut) {
        throw new ApiError({
          status: 0,
          code: 'timeout',
          title: 'Request timed out',
          message: `The request took longer than ${Math.round(limit / 1000)} s.`,
          correlationId,
          cause: error,
        });
      }
      if (input.signal?.aborted) throw error;
      throw new ApiError({
        status: 0,
        code: 'network_error',
        title: 'Network error',
        message: 'The API could not be reached.',
        correlationId,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onCallerAbort);
    }

    const text = await response.text();
    const contentType = response.headers.get('content-type') ?? '';
    const parsed = parseBody(text, contentType);

    if (!response.ok) throw problemToError(response, parsed, correlationId);
    if (response.status === 204 || text === '') return undefined as RouteResponse<K>;
    if (parsed.kind !== 'json') {
      throw new ApiError({
        status: response.status,
        code: 'invalid_response',
        title: 'Unreadable response',
        message: 'The API did not return JSON.',
        correlationId,
      });
    }
    return checkResponse<K>(route, parsed.value, response.status, correlationId);
  }

  function checkResponse<K extends RouteId>(
    route: RouteSpec,
    value: unknown,
    status: number,
    correlationId: string,
  ): RouteResponse<K> {
    const sampled = validation === 'sample' && random() < SAMPLE_RATE;
    if (validation === 'always' || sampled) {
      const result = route.response.safeParse(value);
      if (!result.success) {
        const issues = zodIssues(result.error);
        if (validation === 'always') {
          throw new ApiError({
            status,
            code: 'response_contract_violation',
            title: 'Response does not match the contract',
            message:
              `${route.method} ${route.path} returned data that does not match its schema: ${issues[0]?.path ?? ''} ${issues[0]?.message ?? ''}`.trim(),
            correlationId,
            issues,
          });
        }
        // Sampled mode in production reports the drift but keeps the page working.
        console.warn(`[api] ${route.method} ${route.path} response failed schema validation`, {
          correlationId,
          issues: issues.slice(0, 5),
        });
        return value as RouteResponse<K>;
      }
      return result.data as RouteResponse<K>;
    }
    return value as RouteResponse<K>;
  }

  return { call };
}

type ParsedBody =
  { kind: 'json'; value: unknown } | { kind: 'text'; value: string } | { kind: 'empty' };

function parseBody(text: string, contentType: string): ParsedBody {
  if (text === '') return { kind: 'empty' };
  if (/json/i.test(contentType) || /^\s*[{[]/.test(text)) {
    try {
      return { kind: 'json', value: JSON.parse(text) as unknown };
    } catch {
      return { kind: 'text', value: text };
    }
  }
  return { kind: 'text', value: text };
}

function problemToError(response: Response, parsed: ParsedBody, correlationId: string): ApiError {
  const headerCorrelation = response.headers.get('x-correlation-id') ?? correlationId;
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
  if (parsed.kind === 'json') {
    const problem = ProblemSchema.safeParse(parsed.value);
    if (problem.success) return apiErrorFromProblem(problem.data, headerCorrelation, retryAfterMs);
  }
  // A 5xx without Problem Details was produced by a proxy or gateway in front of the API (for example the Next.js
  // rewrite when the API refuses connections), so it is reported as "API unreachable" rather than as an API fault.
  const unavailable = response.status >= 500 && parsed.kind !== 'json';
  return new ApiError({
    status: response.status,
    code: unavailable ? 'upstream_unavailable' : `http_${response.status}`,
    title: unavailable ? 'API unavailable' : response.statusText || 'Request failed',
    message: `The server answered ${response.status}${response.statusText ? ` ${response.statusText}` : ''}.`,
    correlationId: headerCorrelation,
    retryAfterMs,
  });
}

/** Development guard: a call that does not satisfy the route's own schemas is a programming error, reported before any request. */
function validateRequest(routeId: string, route: RouteSpec, input: InternalInput): void {
  const checks: [
    string,
    (
      | {
          safeParse: (v: unknown) => {
            success: boolean;
            error?: { issues: readonly { path: PropertyKey[]; message: string }[] };
          };
        }
      | undefined
    ),
    unknown,
  ][] = [
    ['params', route.params, input.params],
    ['query', route.query, input.query ?? {}],
    ['body', route.body, input.body],
  ];
  for (const [part, schema, value] of checks) {
    if (!schema) continue;
    const result = schema.safeParse(value);
    if (!result.success && result.error) {
      const issues = zodIssues(result.error);
      throw new ApiError({
        status: 0,
        code: 'invalid_request',
        title: 'Invalid request',
        message:
          `${routeId}: invalid ${part} (${issues[0]?.path ?? ''} ${issues[0]?.message ?? ''})`.trim(),
        issues,
      });
    }
  }
}

/**
 * Default client: same origin, no identity headers. Components must use `useApiClient()` (identity aware); this
 * export exists for scripts and tests.
 */
export function callApi<K extends RouteId>(
  routeId: K,
  ...args: ApiArgs<K>
): Promise<RouteResponse<K>> {
  return createApiClient().call(routeId, ...args);
}
