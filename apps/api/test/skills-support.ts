import { normalizeBundle } from '@caseguard/domain';
import { CaseBundleSchema, type AuditEvent, type CaseBundle } from '@caseguard/schemas';
import {
  CONTOSO,
  PERSONAS,
  type ApiResponse,
  type Harness,
  type Json,
} from './support/app-harness';
import { contextFor } from './support/context';
import { SAMPLE_FILES, ingestSample, loadSampleBundle, toIngestInput } from './support/samples';

/** Helpers shared by the counterfactual and SkillDNA integration tests (HTTP only, real personas). */

export const API = '/api/v1';

/**
 * A resolved case of the same workload that the DNS skill must NOT match: one laptop, fixed by
 * clearing the cache (the same irrelevant case the domain regression tests use).
 */
const IRRELEVANT_BUNDLE: CaseBundle = CaseBundleSchema.parse({
  schemaVersion: 'caseguard.case-bundle/1',
  synthetic: true,
  syntheticNotice: 'SYNTHETIC DEMONSTRATION DATA authored for the skill regression tests.',
  case: {
    reference: 'CG-SYN-9001',
    title: 'One laptop cannot sign in to Teams, fixed by clearing the cache',
    product: 'Microsoft Teams',
    workload: 'teams-authentication',
    severity: 'C',
    status: 'resolved',
    openedAt: '2026-05-04T08:00:00Z',
    customerAlias: 'Adatum Synthetic',
    tags: ['synthetic', 'single-device'],
  },
  participants: [
    { id: 'p-user', role: 'customer_end_user', alias: 'End User 1' },
    { id: 'p-eng', role: 'support_engineer', alias: 'Support Engineer 3' },
  ],
  events: [
    {
      id: 'x01',
      timestamp: '2026-05-04T08:00:00Z',
      participantId: 'p-user',
      type: 'customer_email',
      channel: 'email',
      title: 'Teams will not sign in on my laptop',
      body: 'Hello, only one user is affected: my laptop cannot sign in to Teams since this morning. My colleagues sign in without problems. It fails every time.',
    },
    {
      id: 'x02',
      timestamp: '2026-05-04T08:20:00Z',
      participantId: 'p-eng',
      type: 'engineer_email',
      channel: 'email',
      title: 'Please clear the Teams cache',
      body: 'Hello, please clear the Teams cache on the laptop and try again.',
      action: {
        actionKey: 'act.clear-teams-cache',
        label: 'Ask the user to clear the Teams cache',
        customerEffort: 'medium',
        durationMinutes: 5,
      },
    },
    {
      id: 'x03',
      timestamp: '2026-05-04T08:50:00Z',
      participantId: 'p-user',
      type: 'customer_email',
      channel: 'email',
      title: 'Re: Please clear the Teams cache',
      inResponseTo: 'x02',
      body: 'I cleared the Teams cache on the laptop and it now works, Teams signed in again.',
    },
  ],
  resolution: {
    resolvedAt: '2026-05-04T09:10:00Z',
    summary: 'Clearing the Teams cache restored sign-in on the single affected laptop.',
    rootCause: 'A corrupted local Teams cache on one laptop.',
    rootCauseHypothesisKey: 'hyp.client-cache',
    validation: {
      validatedAt: '2026-05-04T09:05:00Z',
      method: 'The user signed in successfully after the cache was cleared.',
      outcome: 'confirmed',
      evidenceEventIds: ['x03'],
    },
  },
});

/** Ingests the irrelevant single-laptop case and analyses it. */
export async function ingestIrrelevantCase(h: Harness, caseId: string): Promise<void> {
  const normalized = normalizeBundle(IRRELEVANT_BUNDLE, {
    tenantId: CONTOSO,
    caseId,
    sourceId: `src_${caseId}`,
    createdBy: 'system:test',
    now: '2026-10-29T00:00:00.000Z',
    sourceKind: 'builtin_sample',
    storedPayload: JSON.stringify(IRRELEVANT_BUNDLE),
    redactionReplacements: 0,
  });
  await h.repos(CONTOSO).cases.ingest(toIngestInput(normalized, JSON.stringify(IRRELEVANT_BUNDLE)));
  const ctx = contextFor(h, PERSONAS.engineer);
  await ctx.services.analysis.analyzeCase(ctx, caseId);
}

/**
 * Ingests a copy of Case Two under another case reference (the library keeps one case per reference and
 * per payload) and analyses it: one more case the skill of Case One applies to.
 */
export async function ingestCaseTwoCopy(
  h: Harness,
  caseId: string,
  reference: string,
): Promise<void> {
  const original = loadSampleBundle(SAMPLE_FILES.caseTwo);
  const copy: CaseBundle = { ...original, case: { ...original.case, reference } };
  const normalized = normalizeBundle(copy, {
    tenantId: CONTOSO,
    caseId,
    sourceId: `src_${caseId}`,
    createdBy: 'system:test',
    now: '2026-10-29T00:00:00.000Z',
    sourceKind: 'builtin_sample',
    storedPayload: JSON.stringify(copy),
    redactionReplacements: 0,
  });
  await h.repos(CONTOSO).cases.ingest(toIngestInput(normalized, JSON.stringify(copy)));
  const ctx = contextFor(h, PERSONAS.engineer);
  await ctx.services.analysis.analyzeCase(ctx, caseId);
}

/** Every audit event of a tenant, newest first (the repository pages are capped at 200). */
export async function allAuditEvents(h: Harness, tenantId = CONTOSO): Promise<AuditEvent[]> {
  const events: AuditEvent[] = [];
  let cursor: string | undefined;
  do {
    const page = await h.repos(tenantId).audit.list({ limit: 200, cursor });
    events.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return events;
}

export function apiOf(h: Harness) {
  return {
    get: (persona: string | null, url: string): Promise<ApiResponse> =>
      h.call(persona, { method: 'GET', url: `${API}${url}` }),
    post: (
      persona: string | null,
      url: string,
      payload: object = {},
      headers: Record<string, string> = {},
    ): Promise<ApiResponse> =>
      h.call(persona, { method: 'POST', url: `${API}${url}`, payload, headers }),
  };
}

export type TestApi = ReturnType<typeof apiOf>;

/** Ingests Case One (inefficient, DNS cause) and Case Two (efficient, proxy cause) and analyses both. */
export async function ingestAndAnalyse(
  h: Harness,
  ids: { one: string; two: string },
  which: 'both' | 'one' = 'both',
): Promise<void> {
  const repos = h.repos(CONTOSO);
  await ingestSample(repos, SAMPLE_FILES.caseOne, { tenantId: CONTOSO, caseId: ids.one });
  if (which === 'both') {
    await ingestSample(repos, SAMPLE_FILES.caseTwo, { tenantId: CONTOSO, caseId: ids.two });
  }
  const ctx = contextFor(h, PERSONAS.engineer);
  await ctx.services.analysis.analyzeCase(ctx, ids.one);
  if (which === 'both') await ctx.services.analysis.analyzeCase(ctx, ids.two);
}

/** Waits for background jobs and returns the job as the API shows it. */
export async function settledJob(h: Harness, api: TestApi, jobId: string): Promise<Json> {
  await h.infra.services.jobs.idle();
  const res = await api.get(PERSONAS.engineer, `/jobs/${jobId}`);
  if (res.statusCode !== 200) throw new Error(`job ${jobId}: HTTP ${res.statusCode}`);
  return res.data;
}

/** The earliest meaningful fork of a case and its stored scenarios, as the lab shows them. */
export async function earliestForkScenarios(
  h: Harness,
  api: TestApi,
  caseId: string,
): Promise<{ forkId: string; scenarios: Json[] }> {
  const forks = await h.repos(CONTOSO).analysis.listForks(caseId);
  const earliest = forks.find((fork) => fork.isEarliestMeaningful);
  if (earliest === undefined) throw new Error('the case has no earliest meaningful fork');
  const res = await api.get(
    PERSONAS.engineer,
    `/cases/${caseId}/counterfactuals?forkId=${earliest.id}`,
  );
  if (res.statusCode !== 200) throw new Error(`counterfactuals: HTTP ${res.statusCode}`);
  return { forkId: earliest.id, scenarios: res.data.items };
}

/** A reviewer accepts one scenario with a reason (the optimistic lock is the version just read). */
export async function acceptScenario(
  api: TestApi,
  caseId: string,
  scenario: Json,
  reason = 'The path is realistic: every step uses only what was known before the decision.',
): Promise<ApiResponse> {
  return api.post(PERSONAS.reviewer, `/cases/${caseId}/counterfactuals/${scenario.id}/review`, {
    decision: 'accept',
    reason,
    expectedVersion: scenario.version,
  });
}

/** The skill's current optimistic-lock version, as a client would read it before a change. */
export async function skillVersionOf(api: TestApi, skillId: string): Promise<number> {
  const res = await api.get(PERSONAS.engineer, `/skills/${skillId}`);
  if (res.statusCode !== 200) throw new Error(`skill ${skillId}: HTTP ${res.statusCode}`);
  return res.data.skill.version as number;
}

/** Moves a skill one step as `persona`, reading the current version first. */
export async function moveSkill(
  api: TestApi,
  persona: string,
  skillId: string,
  toState: string,
  reason = 'Moved by the governed workflow after review.',
): Promise<ApiResponse> {
  return api.post(persona, `/skills/${skillId}/transition`, {
    toState,
    reason,
    expectedVersion: await skillVersionOf(api, skillId),
  });
}

export async function runValidation(
  api: TestApi,
  persona: string,
  skillId: string,
  body: object,
): Promise<ApiResponse> {
  return api.post(persona, `/skills/${skillId}/simulation-test`, body);
}

/**
 * Walks a freshly extracted skill (`discovered`) to the pilot along the story's path, with the
 * people the gates require: the curator drafts, the reviewer runs the simulation test and signs it
 * off, the curator approves the pilot. The extractor must not be one of them.
 */
export async function walkToPilot(h: Harness, api: TestApi, skillId: string): Promise<void> {
  const fail = (what: string, res: ApiResponse): Error =>
    new Error(`${what}: HTTP ${res.statusCode} ${JSON.stringify(res.data)}`);
  h.clock.advance(60_000);
  const drafted = await moveSkill(api, PERSONAS.curator, skillId, 'draft');
  if (drafted.statusCode !== 200) throw fail('draft', drafted);
  h.clock.advance(60_000);
  const test = await runValidation(api, PERSONAS.reviewer, skillId, { kind: 'simulation_test' });
  if (test.statusCode !== 200) throw fail('simulation test', test);
  for (const [persona, toState] of [
    [PERSONAS.reviewer, 'simulation_tested'],
    [PERSONAS.reviewer, 'expert_reviewed'],
    [PERSONAS.curator, 'pilot'],
  ] as const) {
    h.clock.advance(60_000);
    const moved = await moveSkill(api, persona, skillId, toState);
    if (moved.statusCode !== 200) throw fail(toState, moved);
  }
}
