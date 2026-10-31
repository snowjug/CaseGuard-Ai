import { Api, asPersona, completedSteps, ensurePortfolioDemo, listCases, type Page } from './api';
import { API_ORIGIN, WEB_ORIGIN } from './env';
import { waitForHttp } from './process';

/**
 * Runs once before the specs, after `webServer` reported both servers up: proves that the web tier forwards to the
 * API, that the development personas exist, and that the synthetic demo is seeded (the 13-step portfolio story), then
 * prints the numbers the specs rely on so a run documents what it saw.
 */
export default async function globalSetup(): Promise<void> {
  await waitForHttp(`${API_ORIGIN}/readyz`, {
    timeoutMs: 600_000,
    accept: (status) => status === 200,
  });
  // `/readyz` through the web server is forwarded to the API (src/proxy.ts), so this is the proof that both are wired.
  await waitForHttp(`${WEB_ORIGIN}/readyz`, {
    timeoutMs: 120_000,
    accept: (status) => status === 200,
  });

  const personas = await new Api(null).get<{ enabled: boolean; items: { id: string }[] }>(
    '/dev/personas',
  );
  if (!personas.ok || !personas.body.enabled || personas.body.items.length < 6) {
    throw new Error(
      `The API under test does not offer the six development personas (status ${personas.status}). Is APP_ENV local and AUTH_MODE dev?`,
    );
  }

  const started = Date.now();
  const state = await ensurePortfolioDemo();
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (completedSteps(state) !== state.steps.length || state.steps.length !== 13) {
    throw new Error(
      `The demo story is not complete after seeding: ${completedSteps(state)} of ${state.steps.length}.`,
    );
  }

  const engineer = asPersona('engineer');
  const cases = await listCases(engineer);
  const summary = cases.map(
    (item) =>
      `${item.reference} quality ${item.qualityIndex ?? 'n/a'}, ASE ${item.avoidableEffortPct ?? 'n/a'} %, ${item.eventCount} events, ${item.analysisState}`,
  );
  const forks = state.caseOneId
    ? await engineer.getOk<Page<unknown>>(`/cases/${state.caseOneId}/forks`)
    : null;
  console.log(
    `[e2e] demo ready after ${seconds} s: ${completedSteps(state)} of ${state.steps.length} steps; ${summary.join(' | ')}; Case One forks: ${forks?.items.length ?? 'n/a'}`,
  );
}
