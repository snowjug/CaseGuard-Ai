import { API_ORIGIN } from './env';
import { PERSONAS, type PersonaKey } from './personas';

/** RFC 9457 problem details as the API sends them. Assert on `code` and `reason`, never on `detail`. */
export interface ProblemBody {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly reason?: string;
  readonly detail?: string;
  readonly correlationId?: string;
  readonly errors?: readonly { path: string; message: string }[];
}

export interface ApiResponse<T = unknown> {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Headers;
  readonly text: string;
  /** The parsed JSON body (`undefined` for an empty or non-JSON body). */
  readonly body: T;
  readonly requestId: string | null;
  /** The problem details when the answer is `application/problem+json`. */
  readonly problem: ProblemBody | null;
}

export interface RequestOptions {
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** Defaults to 120 s: the machine may be loaded and a seed or an analysis is slow. */
  readonly timeoutMs?: number;
}

/** A tiny typed client for the API under test, calling it the way the web tier does (JSON, persona header). */
export class Api {
  constructor(
    readonly persona: PersonaKey | null,
    readonly origin: string = API_ORIGIN,
  ) {}

  async request<T = unknown>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    const url = new URL(`/api/v1${path}`, this.origin);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
    if (this.persona !== null) headers['x-cg-persona'] = PERSONAS[this.persona].id;
    let body: string | undefined;
    if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers['content-type'] ??= 'application/json';
    }
    const response = await fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
    });
    const text = await response.text();
    const contentType = response.headers.get('content-type') ?? '';
    let parsed: unknown;
    if (contentType.includes('json') && text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      text,
      body: parsed as T,
      requestId: response.headers.get('x-request-id'),
      problem: contentType.includes('problem+json') ? (parsed as ProblemBody) : null,
    };
  }

  get<T = unknown>(path: string, options?: RequestOptions): Promise<ApiResponse<T>> {
    return this.request<T>('GET', path, options);
  }

  post<T = unknown>(
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<ApiResponse<T>> {
    return this.request<T>('POST', path, { ...options, ...(body === undefined ? {} : { body }) });
  }

  put<T = unknown>(
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<ApiResponse<T>> {
    return this.request<T>('PUT', path, { ...options, ...(body === undefined ? {} : { body }) });
  }

  delete<T = unknown>(path: string, options?: RequestOptions): Promise<ApiResponse<T>> {
    return this.request<T>('DELETE', path, options);
  }

  /** Like `get` but fails with the problem (code, reason, request id) instead of returning a failure. */
  async getOk<T>(path: string, options?: RequestOptions): Promise<T> {
    return orFail(await this.get<T>(path, options), `GET ${path}`);
  }

  async postOk<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return orFail(await this.post<T>(path, body, options), `POST ${path}`);
  }
}

export function orFail<T>(response: ApiResponse<T>, what: string): T {
  if (!response.ok) {
    const problem = response.problem;
    throw new Error(
      `${what} answered ${response.status}${
        problem ? ` ${problem.code}${problem.reason ? `/${problem.reason}` : ''}` : ''
      } (request ${response.requestId ?? 'unknown'}): ${response.text.slice(0, 400)}`,
    );
  }
  return response.body;
}

export const asPersona = (key: PersonaKey, origin: string = API_ORIGIN): Api =>
  new Api(key, origin);
export const anonymous = (origin: string = API_ORIGIN): Api => new Api(null, origin);

// ---------------------------------------------------------------- the few shapes the helpers read

export interface DemoStep {
  readonly id: string;
  readonly order: number;
  readonly title: string;
  readonly persona: string;
  readonly actionLabel: string;
  readonly route: string;
  readonly completed: boolean;
  readonly enabled: boolean;
  readonly isNextAction: boolean;
}

export interface DemoState {
  readonly steps: readonly DemoStep[];
  readonly seededAt: string | null;
  readonly datasetLabel: string;
  readonly provider: string;
  readonly providerSimulated: boolean;
  readonly caseOneId: string | null;
  readonly caseTwoId: string | null;
  readonly skillId: string | null;
  readonly notices: readonly string[];
}

export interface CaseSummary {
  readonly id: string;
  readonly reference: string;
  readonly title: string;
  readonly status: string;
  readonly severity: string;
  readonly customerAlias: string;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly synthetic: boolean;
  readonly eventCount: number;
  readonly analysisState: string;
  readonly qualityIndex: number | null;
  readonly avoidableEffortPct: number | null;
  readonly leadingHypothesis: { readonly name: string; readonly confidence: number } | null;
  readonly openWarningCount: number;
  readonly injectionDetected: boolean;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly total?: number;
}

export interface Job {
  readonly id: string;
  readonly kind: string;
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  readonly caseId: string | null;
  readonly progress: { readonly percent: number; readonly stage: string };
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly cancellable: boolean;
}

export const completedSteps = (state: DemoState): number =>
  state.steps.filter((step) => step.completed).length;

/** Polls a job until it finished; fails with its error when it did not succeed. */
export async function waitForJob(api: Api, jobId: string, timeoutMs = 300_000): Promise<Job> {
  // `performance.now()` is monotonic: a clock adjustment on a long run must not end the wait early.
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const job = await api.getOk<Job>(`/jobs/${jobId}`);
    if (job.status === 'succeeded') return job;
    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new Error(
        `job ${jobId} ${job.status}: ${job.error?.code ?? ''} ${job.error?.message ?? ''}`,
      );
    }
    if (performance.now() > deadline)
      throw new Error(`job ${jobId} still ${job.status} after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/** Lists every case of the caller's workspace (the demo has two; a run adds at most a handful). */
export async function listCases(api: Api): Promise<CaseSummary[]> {
  const items: CaseSummary[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<CaseSummary> = await api.getOk<Page<CaseSummary>>('/cases', {
      query: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

/** The demo state as the administrator sees it (every role reads the same, derived from stored data). */
export async function demoState(): Promise<DemoState> {
  return asPersona('admin').getOk<DemoState>('/demo/state');
}

/** Waits while a seed or reset job of the workspace is running (the routes answer 409 `job_active` meanwhile). */
async function whileJobActive<T>(attempt: () => Promise<ApiResponse<T>>, what: string): Promise<T> {
  const deadline = performance.now() + 600_000;
  for (;;) {
    const response = await attempt();
    if (response.ok) return response.body;
    if (response.problem?.reason === 'job_active' && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      continue;
    }
    return orFail(response, what);
  }
}

/** The whole story played into the workspace (13 of 13 steps). Idempotent and cheap when it already holds. */
export async function ensurePortfolioDemo(): Promise<DemoState> {
  const current = await demoState();
  if (completedSteps(current) === current.steps.length && current.steps.length > 0) return current;
  return whileJobActive(
    () =>
      asPersona('admin').post<DemoState>(
        '/demo/seed',
        { profile: 'portfolio' },
        { timeoutMs: 900_000 },
      ),
    'POST /demo/seed (portfolio)',
  );
}

/** A clean workspace with the story at step 1 (0 of 13): the starting point of the live demo. */
export async function resetToBaseDemo(): Promise<DemoState> {
  const admin = asPersona('admin');
  await whileJobActive(() => admin.post<DemoState>('/demo/reset'), 'POST /demo/reset');
  return whileJobActive(
    () => admin.post<DemoState>('/demo/seed', { profile: 'base' }),
    'POST /demo/seed (base)',
  );
}

/** The two demo cases (ids from the demo state) and the skill the story publishes. */
export interface DemoIds {
  readonly caseOneId: string;
  readonly caseTwoId: string;
  readonly skillId: string;
}

export async function demoIds(): Promise<DemoIds> {
  const state = await demoState();
  if (!state.caseOneId || !state.caseTwoId || !state.skillId) {
    throw new Error(
      'The demo is not seeded (no Case One, Case Two or skill); call ensurePortfolioDemo first.',
    );
  }
  return { caseOneId: state.caseOneId, caseTwoId: state.caseTwoId, skillId: state.skillId };
}
