import { DemoStateSchema, type AuditEvent, type DemoState } from '@caseguard/schemas';
import { CONTOSO, PERSONAS, type ApiResponse, type Harness } from './support/app-harness';

/** Helpers shared by the insights and demo integration tests (HTTP only, real personas). */

export const API = '/api/v1';

/** A whole story runs two analyses and a dozen governed steps: generous on a loaded machine. */
export const STORY_TIMEOUT_MS = 600_000;

export function apiOf(h: Harness) {
  return {
    get: (persona: string | null, url: string): Promise<ApiResponse> =>
      h.call(persona, { method: 'GET', url: `${API}${url}` }),
    post: (persona: string | null, url: string, payload: object = {}): Promise<ApiResponse> =>
      h.call(persona, { method: 'POST', url: `${API}${url}`, payload }),
  };
}

export type TestApi = ReturnType<typeof apiOf>;

/** Every audit event of a tenant, oldest first within each page (the repository caps pages at 200). */
export async function allAudit(h: Harness, tenantId = CONTOSO): Promise<AuditEvent[]> {
  const events: AuditEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = await h.repos(tenantId).audit.list({ limit: 200, cursor });
    events.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return events;
}

/** The guide as the web app would read it, validated against the contract. */
export async function demoState(
  api: TestApi,
  persona: string | null = PERSONAS.engineer,
): Promise<DemoState> {
  const res = await api.get(persona, '/demo/state');
  if (res.statusCode !== 200) throw new Error(`demo.state: HTTP ${res.statusCode}`);
  return DemoStateSchema.parse(res.data);
}

/** Which of the 13 steps are done, as the 1-based step numbers. */
export const completedSteps = (state: DemoState): number[] =>
  state.steps.filter((step) => step.completed).map((step) => step.order);

/** The guide after the whole story was played, with the ids it created. */
export interface SeededStory {
  readonly state: DemoState;
  readonly caseOneId: string;
  readonly caseTwoId: string;
  readonly skillId: string;
}

/** The error-level log lines so far, as short text, to explain an unexpected 500 in a test report. */
export function errorLines(h: Harness): string {
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  return h
    .logs()
    .filter((line) => line.level === 50 || line.level === 'error')
    .map((line) => {
      const err = line.err as { message?: unknown; stack?: unknown } | undefined;
      const where = (text(err?.stack).split('\n')[1] ?? '').trim();
      return `${text(line.msg) || text(line.event)}: ${text(err?.message)} ${where}`;
    })
    .join('\n');
}

/** Plays the portfolio story through `demo.seed` as the administrator, as the web app would. */
export async function seedPortfolio(h: Harness, api: TestApi): Promise<SeededStory> {
  const res = await api.post(PERSONAS.admin, '/demo/seed', { profile: 'portfolio' });
  if (res.statusCode !== 200) {
    throw new Error(
      `demo.seed: HTTP ${res.statusCode} ${JSON.stringify(res.data)}\n${errorLines(h)}`,
    );
  }
  const state = await demoState(api);
  const { caseOneId, caseTwoId, skillId } = state;
  if (caseOneId === null || caseTwoId === null || skillId === null) {
    throw new Error('demo.seed finished without both cases and the skill');
  }
  return { state, caseOneId, caseTwoId, skillId };
}

/** Waits for the background jobs of a harness to finish. */
export async function settle(h: Harness): Promise<void> {
  await h.infra.services.jobs.idle();
}
