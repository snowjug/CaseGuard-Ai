/* eslint-disable @typescript-eslint/no-unsafe-return -- response bodies are parsed JSON, typed `Json` by the harness */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PROVENANCE_MAX_LINKS,
  ProvenanceResponseSchema,
  type CaseEvent,
  type Claim,
  type DiagnosticAction,
  type Evidence,
  type MissingEvidence,
} from '@caseguard/schemas';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import { parseProvenanceLinks } from '../src/services/views';
import { buildEvidence, buildIngestInput, buildSnapshot, type IngestOptions } from './builders';
import {
  CONTOSO,
  FABRIKAM,
  PERSONAS,
  createHarness,
  openSharedDatabase,
  type ApiResponse,
  type Harness,
  type Json,
} from './support/app-harness';
import { contextFor } from './support/context';
import { SAMPLE_FILES, ingestSample } from './support/samples';
import { AS_OF_SUFFIXES, eventBySuffix, findLeaks, leakProbe } from './views-support';

const ONE = 'case_prov_one';
const TWO = 'case_prov_two';
const CRAFT = 'case_prov_craft';
const FRESH = 'case_prov_fresh';
const FOREIGN = 'case_prov_foreign';

let database: Database;
let h: Harness;
let oneEvents: CaseEvent[];
let evidence: Evidence[];
let claims: Claim[];
let actions: DiagnosticAction[];
let missing: MissingEvidence[];

/** Calls `provenance.resolve` and checks every 200 answer against the contract. */
async function resolve(
  persona: string | null,
  caseId: string,
  links: readonly string[] | string,
  asOf?: string,
): Promise<ApiResponse> {
  const list = typeof links === 'string' ? links : links.join(',');
  const query = `links=${encodeURIComponent(list)}${asOf === undefined ? '' : `&asOf=${encodeURIComponent(asOf)}`}`;
  const res = await h.call(persona, {
    method: 'GET',
    url: `/api/v1/cases/${caseId}/provenance?${query}`,
  });
  if (res.statusCode === 200) expect(() => ProvenanceResponseSchema.parse(res.data)).not.toThrow();
  return res;
}

const itemOf = (res: ApiResponse, link: string): Json =>
  (res.data.items as Json[]).find((item) => `${item.link.type}:${item.link.id}` === link);

/** A case whose references are written by hand, so that each state of a check has a known cause. */
const craftOptions: IngestOptions = { caseId: CRAFT, eventCount: 6, receivedSeed: 'craft' };
const CRAFT_BODY = 'Synthetic body of event 2.';

beforeAll(async () => {
  database = await openSharedDatabase();
  h = await createHarness({ database });
  const repos = h.repos(CONTOSO);
  const one = await ingestSample(repos, SAMPLE_FILES.caseOne, { tenantId: CONTOSO, caseId: ONE });
  await ingestSample(repos, SAMPLE_FILES.caseTwo, { tenantId: CONTOSO, caseId: TWO });
  await ingestSample(h.repos(FABRIKAM), SAMPLE_FILES.caseTwo, {
    tenantId: FABRIKAM,
    caseId: FOREIGN,
  });
  oneEvents = one.events;

  const engineer = contextFor(h, PERSONAS.engineer);
  await h.infra.services.analysis.analyzeCase(engineer, ONE);
  await h.infra.services.analysis.analyzeCase(engineer, TWO);
  await h.infra.services.analysis.analyzeCase(contextFor(h, PERSONAS.otherTenantEngineer), FOREIGN);

  // The hand-written case: evidence 1 is a real quotation, 2 was tampered with, 3 predates the field.
  const input = buildIngestInput(craftOptions);
  await repos.cases.ingest(input);
  const snapshot = buildSnapshot(input);
  const [first, second, third] = snapshot.evidence;
  const event = input.events[1];
  if (first === undefined || second === undefined || third === undefined || event === undefined) {
    throw new Error('the crafted case is incomplete');
  }
  expect(event.body).toBe(CRAFT_BODY);
  snapshot.evidence = [
    buildEvidence({
      ...first,
      eventId: event.id,
      sourceRef: {
        eventId: event.id,
        sourceId: event.sourceId,
        pointer: `${event.sourcePointer}/body`,
        field: 'body',
        start: 10,
        end: 14,
        excerpt: 'body',
      },
    }),
    buildEvidence({
      ...second,
      eventId: event.id,
      sourceRef: {
        eventId: event.id,
        sourceId: event.sourceId,
        pointer: `${event.sourcePointer}/body`,
        field: 'body',
        start: 10,
        end: 14,
        excerpt: 'a quotation the stored message never contained',
      },
    }),
    buildEvidence({
      ...third,
      eventId: event.id,
      sourceRef: {
        eventId: event.id,
        sourceId: event.sourceId,
        pointer: `${event.sourcePointer}/body`,
        start: 10,
        end: 14,
        excerpt: 'body',
      },
    }),
  ];
  await repos.analysis.saveSnapshot(snapshot);

  // A case that was never analysed.
  await repos.cases.ingest(buildIngestInput({ caseId: FRESH, receivedSeed: 'fresh' }));

  [evidence, claims, actions, missing] = await Promise.all([
    repos.analysis.listEvidence(ONE),
    repos.analysis.listClaims(ONE, { limit: 200 }).then((page) => page.items),
    repos.analysis.listActions(ONE),
    repos.analysis.listMissing(ONE),
  ]);
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);

afterAll(async () => {
  await h.close();
  await database.close();
});

describe('the links of a request', () => {
  it('reads type:id pairs, keeps colons that belong to an id, and ignores duplicates', () => {
    expect(
      parseProvenanceLinks(' event:evt_1 , evidence:evd_ab12,event:evt_1,hypothesis:hyp.dns:x '),
    ).toEqual([
      { type: 'event', id: 'evt_1' },
      { type: 'evidence', id: 'evd_ab12' },
      { type: 'hypothesis', id: 'hyp.dns:x' },
    ]);
  });

  it('refuses an entry that is not a link, naming its position and never its text', () => {
    for (const bad of [
      'evidence',
      'evidence:',
      ':evd_1',
      'person:evd_1',
      'evidence:evd 1',
      'evidence:evd_1,,claim:clm_1',
      'event:ok,SECRET-TEXT',
    ]) {
      expect(() => parseProvenanceLinks(bad), bad).toThrow(/is not of the form type:id/);
    }
    expect(() => parseProvenanceLinks('event:ok,SECRET-TEXT')).toThrow(/Link 2 /);
    expect(() => parseProvenanceLinks('event:ok,SECRET-TEXT')).not.toThrow(/SECRET/);
  });

  it('allows as many different links as the contract does, and no more', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `event:e${i}`).join(',');
    expect(parseProvenanceLinks(many(PROVENANCE_MAX_LINKS))).toHaveLength(PROVENANCE_MAX_LINKS);
    expect(() => parseProvenanceLinks(many(PROVENANCE_MAX_LINKS + 1))).toThrow(/At most 40/);
    // Repeats do not count against the limit.
    expect(parseProvenanceLinks(`${many(PROVENANCE_MAX_LINKS)},${many(10)}`)).toHaveLength(40);
  });
});

describe('who may resolve links, and for which case', () => {
  const link = () => `event:${oneEvents[0]?.id}`;

  it('is open to everybody who may read the case, and to nobody else', async () => {
    for (const persona of [
      PERSONAS.engineer,
      PERSONAS.reviewer,
      PERSONAS.manager,
      PERSONAS.curator,
      PERSONAS.admin,
    ]) {
      const res = await resolve(persona, ONE, link());
      expect(res.statusCode, persona).toBe(200);
      expect(res.data.items).toHaveLength(1);
    }
    expect((await resolve(null, ONE, link())).statusCode).toBe(401);
  });

  it("answers another tenant's case with a 404, and an unknown case the same way", async () => {
    const foreign = await resolve(PERSONAS.otherTenantEngineer, ONE, link());
    const unknown = await resolve(PERSONAS.engineer, 'case_prov_unknown', link());
    expect(foreign.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(foreign.data.code).toBe('not_found');
    expect(JSON.stringify(foreign.data)).not.toContain(oneEvents[0]?.title ?? 'NO-TITLE');
    // The other tenant's own case is reachable by that tenant only.
    expect((await resolve(PERSONAS.otherTenantEngineer, FOREIGN, link())).statusCode).toBe(200);
    expect((await resolve(PERSONAS.engineer, FOREIGN, link())).statusCode).toBe(404);
  });

  it("does not resolve a record of another case or of another tenant's case", async () => {
    const twoEvidence = (await h.repos(CONTOSO).analysis.listEvidence(TWO))[0];
    const foreignEvidence = (await h.repos(FABRIKAM).analysis.listEvidence(FOREIGN))[0];
    const foreignEvent = (await h.repos(FABRIKAM).cases.getAllEvents(FOREIGN))[0];
    const res = await resolve(PERSONAS.engineer, ONE, [
      `evidence:${twoEvidence?.id}`,
      `evidence:${foreignEvidence?.id}`,
      `event:${foreignEvent?.id}`,
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.data.items).toEqual([]);
    expect((res.data.unresolved as Json[]).map((u) => u.reason)).toEqual([
      'not_found',
      'not_found',
      'not_found',
    ]);
  });
});

describe('every kind of link resolves to what it points at', () => {
  it('names an event, its type, who wrote it and when', async () => {
    const event = oneEvents[0] as CaseEvent;
    const res = await resolve(PERSONAS.engineer, ONE, `event:${event.id}`);
    expect(res.data).toMatchObject({ caseId: ONE, asOf: null, unresolved: [] });
    expect(res.data.items[0]).toEqual({
      link: { type: 'event', id: event.id },
      title: event.title,
      at: event.timestamp,
      event: {
        id: event.id,
        title: event.title,
        type: event.type,
        participantRole: event.participantRole,
        timestamp: event.timestamp,
      },
      source: null,
    });
  });

  it('quotes verified evidence from the stored text and names its exact source', async () => {
    const found = evidence.find(
      (item) => item.sourceRef.field === 'body' && item.excerpt.includes('roughly 140 users'),
    ) as Evidence;
    const event = oneEvents.find((e) => e.id === found.eventId) as CaseEvent;
    const stored = await h.repos(CONTOSO).cases.getSource(ONE);
    const res = await resolve(PERSONAS.engineer, ONE, `evidence:${found.id}`);
    const item = res.data.items[0];
    expect(item).toMatchObject({
      link: { type: 'evidence', id: found.id },
      title: found.label,
      at: found.observedAt,
      event: { id: event.id, title: event.title },
    });
    expect(item.source).toMatchObject({
      eventId: event.id,
      sourceId: event.sourceId,
      field: 'body',
      start: found.sourceRef.start,
      end: found.sourceRef.end,
      excerpt: found.excerpt,
      verification: 'verified',
      contentHash: stored?.storedSha256,
    });
    expect(item.source.context.match).toBe('140 users');
    expect(item.source.context.before.endsWith('roughly ')).toBe(true);
    // The quotation is stored text, word for word.
    const { before, match, after } = item.source.context;
    expect(event.body.includes(`${before}${match}${after}`)).toBe(true);
  });

  it('quotes a match in the title from the title', async () => {
    const found = evidence.find((item) => item.sourceRef.field === 'title') as Evidence;
    const res = await resolve(PERSONAS.engineer, ONE, `evidence:${found.id}`);
    expect(res.data.items[0].source).toMatchObject({ field: 'title', verification: 'verified' });
    expect(res.data.items[0].source.context.match).toBe('intermittently');
  });

  it('claims nothing about structured values and derived statements', async () => {
    const structured = evidence.find((item) => item.method === 'structured') as Evidence;
    const derived = claims.find(
      (claim) => claim.method === 'derived' && claim.sourceRef !== null,
    ) as Claim;
    const res = await resolve(PERSONAS.engineer, ONE, [
      `evidence:${structured.id}`,
      `claim:${derived.id}`,
    ]);
    for (const item of res.data.items as Json[]) {
      expect(item.source).toMatchObject({ verification: 'not_checkable', context: null });
      expect(item.source.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(item.source.field).toBeNull();
    }
  });

  it('quotes a claim made from a statement, and a claim made from evidence', async () => {
    const statement = claims.find(
      (claim) => claim.ruleId.startsWith('statement.') && claim.sourceRef?.field === 'body',
    ) as Claim;
    const fromEvidence = claims.find(
      (claim) => claim.ruleId.startsWith('evidence.') && claim.sourceRef?.field === 'body',
    ) as Claim;
    const res = await resolve(PERSONAS.reviewer, ONE, [
      `claim:${statement.id}`,
      `claim:${fromEvidence.id}`,
    ]);
    const event = oneEvents.find((e) => e.id === statement.eventId) as CaseEvent;
    const [a, b] = res.data.items as Json[];
    expect(a.at).toBe(statement.timestamp);
    expect(a.title.startsWith(statement.text.slice(0, 250))).toBe(true);
    expect(a.source.verification).toBe('verified');
    expect(a.source.context.match).toBe(statement.text);
    expect(a.event.id).toBe(event.id);
    expect(b.source.verification).toBe('verified');
  });

  it('resolves a decision, an action, a possible cause and a missing-evidence requirement', async () => {
    const repos = h.repos(CONTOSO);
    const fork = (await repos.analysis.listForks(ONE)).find((f) => f.isEarliestMeaningful);
    const action = actions[0] as DiagnosticAction;
    const hypothesis = (await repos.analysis.listHypotheses(ONE))[0];
    const satisfied = missing.find((m) => m.resolvedByEventId !== null) as MissingEvidence;
    const res = await resolve(PERSONAS.manager, ONE, [
      `fork:${fork?.id}`,
      `action:${action.id}`,
      `hypothesis:${hypothesis?.id}`,
      `hypothesis:${hypothesis?.key}`,
      `requirement:${satisfied.requirementId}`,
      `requirement:${satisfied.id}`,
    ]);
    expect(res.data.unresolved).toEqual([]);
    const items = res.data.items as Json[];
    expect(items[0]).toMatchObject({ title: fork?.title, at: fork?.timestamp });
    expect(items[0].event.id).toBe(fork?.eventId);
    expect(items[1]).toMatchObject({ title: action.label, at: action.startedAt });
    expect(items[1].event.id).toBe(action.eventId);
    // A hypothesis answers to its record id and to the knowledge-pack key that checks and claims use.
    expect(items[2].title).toBe(hypothesis?.name);
    expect(items[3].title).toBe(hypothesis?.name);
    expect(items[2]).toMatchObject({ at: null, event: null, source: null });
    // A requirement answers to the pack id and to its record id, and names the message that satisfied it.
    expect(items[4]).toMatchObject({ title: satisfied.label, at: satisfied.firstRelevantAt });
    expect(items[4].event.id).toBe(satisfied.resolvedByEventId);
    expect(items[5].title).toBe(satisfied.label);
  });

  it('resolves a simulated path to the decision it was made for', async () => {
    const repos = h.repos(CONTOSO);
    const scenario = (await repos.counterfactuals.list(ONE))[0];
    const fork = (await repos.analysis.listForks(ONE)).find((f) => f.id === scenario?.forkId);
    const res = await resolve(PERSONAS.engineer, ONE, `scenario:${scenario?.id}`);
    expect(res.data.items[0]).toMatchObject({
      title: scenario?.label,
      at: scenario?.boundary.asOf,
      source: null,
    });
    expect(res.data.items[0].event.id).toBe(fork?.eventId);
  });

  it('keeps the order of the request, drops repeats, and reports every link it cannot resolve', async () => {
    const event = oneEvents[0] as CaseEvent;
    const res = await resolve(PERSONAS.engineer, ONE, [
      'evidence:evd_does_not_exist',
      `event:${event.id}`,
      'claim:clm_does_not_exist',
      `event:${event.id}`,
      'fork:frk_does_not_exist',
      'action:act_does_not_exist',
      'hypothesis:hyp.does-not-exist',
      'requirement:req.does-not-exist',
      'scenario:scn_does_not_exist',
      'event:evt_does_not_exist',
    ]);
    expect(res.statusCode).toBe(200);
    expect((res.data.items as Json[]).map((i) => i.link.id)).toEqual([event.id]);
    expect((res.data.unresolved as Json[]).map((u) => `${u.link.type}:${u.reason}`)).toEqual([
      'evidence:not_found',
      'claim:not_found',
      'fork:not_found',
      'action:not_found',
      'hypothesis:not_found',
      'requirement:not_found',
      'scenario:not_found',
      'event:not_found',
    ]);
  });
});

describe('whether the stored text holds what the analysis recorded', () => {
  const link = (index: number) => `evidence:ev_${CRAFT}_${index}`;

  it('verifies a quotation, refuses a tampered one and does not claim a legacy one', async () => {
    const stored = await h.repos(CONTOSO).cases.getSource(CRAFT);
    const res = await resolve(PERSONAS.engineer, CRAFT, [link(1), link(2), link(3)]);
    expect(res.data.unresolved).toEqual([]);
    const [verified, tampered, legacy] = res.data.items as Json[];
    expect(verified.source).toMatchObject({
      verification: 'verified',
      excerpt: 'body',
      contentHash: stored?.storedSha256,
      context: { before: 'Synthetic ', match: 'body', after: ' of event 2.' },
    });
    // What was recorded is reported as recorded, but never shown as a quotation.
    expect(tampered.source).toMatchObject({
      verification: 'mismatch',
      excerpt: 'a quotation the stored message never contained',
      context: null,
    });
    // Offsets without the text they count into cannot be applied to anything.
    expect(legacy.source).toMatchObject({
      verification: 'not_checkable',
      field: null,
      start: 10,
      end: 14,
      context: null,
    });
  });
});

describe('what a case that was never analysed can answer', () => {
  it('resolves its events and reports everything derived as not found', async () => {
    const events = await h.repos(CONTOSO).cases.getAllEvents(FRESH);
    const res = await resolve(PERSONAS.engineer, FRESH, [
      `event:${events[0]?.id}`,
      'evidence:evd_x',
      'claim:clm_x',
      'hypothesis:hyp.dns-resolution',
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.data.items).toHaveLength(1);
    expect((res.data.unresolved as Json[]).map((u) => u.reason)).toEqual([
      'not_found',
      'not_found',
      'not_found',
    ]);
    const asOf = await resolve(PERSONAS.engineer, FRESH, 'evidence:evd_x', events[2]?.timestamp);
    expect(asOf.data.unresolved[0].reason).toBe('not_found');
  });
});

describe('a request that is not well formed', () => {
  const url = (query: string) => `/api/v1/cases/${ONE}/provenance${query}`;
  const call = (query: string) => h.call(PERSONAS.engineer, { method: 'GET', url: url(query) });

  it('is a 400 problem for an entry that is not a link, without echoing it', async () => {
    for (const links of ['evidence', 'person:abc', 'event:ok,,event:ok2', 'event:has space']) {
      const res = await call(`?links=${encodeURIComponent(links)}`);
      expect(res.statusCode, links).toBe(400);
      expect(res.data.code).toBe('validation_failed');
      expect(res.data.detail).toMatch(/is not of the form type:id/);
    }
    const secret = await call(`?links=${encodeURIComponent('event:a,TOP-SECRET-TEXT')}`);
    expect(JSON.stringify(secret.data)).not.toContain('TOP-SECRET-TEXT');
  });

  it('is a 422 problem for a missing or oversized list and for an instant that is not one', async () => {
    expect((await call('')).statusCode).toBe(422);
    expect((await call('?links=ab')).statusCode).toBe(422);
    expect((await call(`?links=${'a'.repeat(4001)}`)).statusCode).toBe(422);
    expect((await call('?links=event:abc&asOf=yesterday')).statusCode).toBe(422);
    const many = Array.from({ length: PROVENANCE_MAX_LINKS + 1 }, (_, i) => `event:e${i}`).join(
      ',',
    );
    const res = await call(`?links=${encodeURIComponent(many)}`);
    expect(res.statusCode).toBe(422);
    expect(res.data.errors[0].path).toBe('links');
  });

  it('accepts exactly the largest list', async () => {
    const many = Array.from({ length: PROVENANCE_MAX_LINKS }, (_, i) => `event:none_${i}`).join(
      ',',
    );
    const res = await resolve(PERSONAS.engineer, ONE, many);
    expect(res.statusCode).toBe(200);
    expect(res.data.unresolved).toHaveLength(PROVENANCE_MAX_LINKS);
  });
});

describe('as of an instant, nothing recorded later is shown', () => {
  const asOfEvent = () => eventBySuffix(oneEvents, 'e07');

  it('reports what comes later as not yet known, with nothing else about it', async () => {
    const asOf = asOfEvent().timestamp;
    const t = Date.parse(asOf);
    const laterEvent = oneEvents.find((e) => Date.parse(e.timestamp) > t) as CaseEvent;
    const laterEvidence = evidence.find((e) => Date.parse(e.observedAt) > t) as Evidence;
    const laterClaim = claims.find((c) => Date.parse(c.timestamp) > t) as Claim;
    const laterAction = actions.find((a) => Date.parse(a.startedAt) > t) as DiagnosticAction;
    const laterFork = (await h.repos(CONTOSO).analysis.listForks(ONE)).find(
      (f) => Date.parse(f.timestamp) > t,
    );
    const laterRequirement = missing.find((m) => Date.parse(m.firstRelevantAt) > t);
    const scenarios = await h.repos(CONTOSO).counterfactuals.list(ONE);
    const laterScenario = scenarios.find((s) => Date.parse(s.boundary.asOf) > t);
    expect(laterFork && laterRequirement && laterScenario).toBeTruthy();
    const links = [
      `event:${laterEvent.id}`,
      `evidence:${laterEvidence.id}`,
      `claim:${laterClaim.id}`,
      `action:${laterAction.id}`,
      `fork:${laterFork?.id}`,
      // By its record, which exists only once the case has reached the requirement.
      `requirement:${laterRequirement?.id}`,
      `scenario:${laterScenario?.id}`,
    ];
    const res = await resolve(PERSONAS.engineer, ONE, links, asOf);
    expect(res.statusCode).toBe(200);
    expect(res.data.asOf).toBe(asOf);
    expect(res.data.items).toEqual([]);
    expect((res.data.unresolved as Json[]).map((u) => u.reason)).toEqual(
      links.map(() => 'not_yet_known'),
    );
    // The same links in the whole record are all known.
    const whole = await resolve(PERSONAS.engineer, ONE, links);
    expect(whole.data.unresolved).toEqual([]);
  });

  it('serves what is known from the analysis of that window, not from the final one', async () => {
    const asOf = asOfEvent().timestamp;
    const t = Date.parse(asOf);
    const earlier = evidence
      .filter((e) => e.sourceRef.field !== undefined && Date.parse(e.observedAt) <= t)
      .slice(0, 3);
    const hypothesis = (await h.repos(CONTOSO).analysis.listHypotheses(ONE))[0];
    const links = [...earlier.map((e) => `evidence:${e.id}`), `hypothesis:${hypothesis?.id}`];
    const res = await resolve(PERSONAS.engineer, ONE, links, asOf);
    expect(res.data.unresolved).toEqual([]);
    expect(res.data.items).toHaveLength(links.length);
    // The ledger of the same window holds the same claims and evidence.
    const ledger = await h.call(PERSONAS.engineer, {
      method: 'GET',
      url: `/api/v1/cases/${ONE}/evidence?asOf=${encodeURIComponent(asOf)}&limit=200`,
    });
    const inWindow = new Map((ledger.data.evidence as Json[]).map((e) => [e.id, e]));
    for (const e of earlier) {
      const item = itemOf(res, `evidence:${e.id}`);
      const same = inWindow.get(e.id);
      if (same !== undefined) expect(item.title).toBe(same.label);
      expect(item.source.verification).toBe('verified');
    }
  });

  it('names a requirement the case has not reached from what the knowledge pack says, and nothing more', async () => {
    const t = Date.parse(asOfEvent().timestamp);
    const notReached = missing.find((m) => Date.parse(m.firstRelevantAt) > t) as MissingEvidence;
    expect(notReached).toBeDefined();
    const link = `requirement:${notReached.requirementId}`;
    const inWindow = await resolve(PERSONAS.engineer, ONE, link, asOfEvent().timestamp);
    // No time, no message: the case has not reached it, and when it will is not told.
    expect(inWindow.data.items[0]).toMatchObject({
      title: notReached.label,
      at: null,
      event: null,
      source: null,
    });
    const whole = await resolve(PERSONAS.engineer, ONE, link);
    expect(whole.data.items[0]).toMatchObject({ at: notReached.firstRelevantAt });
  });

  it('does not reveal that a requirement was satisfied later', async () => {
    // Any message of the case at which some requirement is already relevant but not yet satisfied.
    const window = oneEvents
      .map((event) => ({
        asOf: event.timestamp,
        later: missing.find(
          (m) =>
            Date.parse(m.firstRelevantAt) <= Date.parse(event.timestamp) &&
            m.resolvedAt !== null &&
            Date.parse(m.resolvedAt) > Date.parse(event.timestamp),
        ),
      }))
      .find((candidate) => candidate.later !== undefined);
    const later = window?.later as MissingEvidence;
    expect(later, 'a requirement that is relevant first and satisfied later').toBeDefined();
    const link = `requirement:${later.requirementId}`;
    const inWindow = await resolve(PERSONAS.engineer, ONE, link, window?.asOf);
    expect(inWindow.data.items[0]).toMatchObject({
      title: later.label,
      at: later.firstRelevantAt,
      event: null,
    });
    const whole = await resolve(PERSONAS.engineer, ONE, link);
    expect(whole.data.items[0].event.id).toBe(later.resolvedByEventId);
  });

  it('shows no trace of later events in any answer of an earlier window (and the probe is live)', async () => {
    const resolution = await h.repos(CONTOSO).cases.getResolution(ONE);
    const all = [
      ...evidence.map((e) => `evidence:${e.id}`),
      ...claims.map((c) => `claim:${c.id}`),
      ...actions.map((a) => `action:${a.id}`),
    ].slice(0, 120);
    for (const suffix of AS_OF_SUFFIXES) {
      const asOf = eventBySuffix(oneEvents, suffix).timestamp;
      const probe = leakProbe(oneEvents, resolution, asOf, 'teams-authentication');
      const bodies: string[] = [];
      // 40 links per request.
      for (let i = 0; i < all.length; i += 40) {
        const res = await resolve(PERSONAS.engineer, ONE, all.slice(i, i + 40), asOf);
        expect(res.statusCode, suffix).toBe(200);
        bodies.push(res.body);
      }
      expect(findLeaks(bodies.join('\n'), probe), suffix).toEqual([]);
    }
    // Negative control: the whole record does contain what an early window must not.
    const early = leakProbe(
      oneEvents,
      resolution,
      eventBySuffix(oneEvents, 'e02').timestamp,
      'teams-authentication',
    );
    const wholeBodies: string[] = [];
    for (let i = 0; i < all.length; i += 40) {
      wholeBodies.push((await resolve(PERSONAS.engineer, ONE, all.slice(i, i + 40))).body);
    }
    expect(findLeaks(wholeBodies.join('\n'), early).length).toBeGreaterThan(0);
  });

  it('knows nothing yet before the first event, apart from what exists from the start', async () => {
    const asOf = '2000-01-01T00:00:00Z';
    const hypothesis = (await h.repos(CONTOSO).analysis.listHypotheses(ONE))[0];
    const res = await resolve(
      PERSONAS.engineer,
      ONE,
      [
        `event:${oneEvents[0]?.id}`,
        `evidence:${evidence[0]?.id}`,
        `claim:${claims[0]?.id}`,
        `hypothesis:${hypothesis?.id}`,
      ],
      asOf,
    );
    expect(res.statusCode).toBe(200);
    expect((res.data.unresolved as Json[]).map((u) => `${u.link.type}:${u.reason}`)).toEqual([
      'event:not_yet_known',
      'evidence:not_yet_known',
      'claim:not_yet_known',
    ]);
    expect(res.data.items).toHaveLength(1);
    expect(res.data.items[0].link.type).toBe('hypothesis');
  });

  it('shows a simulated path only once the decision it was made for has been reached', async () => {
    const scenario = (await h.repos(CONTOSO).counterfactuals.list(ONE))[0];
    const at = scenario?.boundary.asOf ?? '';
    const before = new Date(Date.parse(at) - 1000).toISOString();
    expect(
      (await resolve(PERSONAS.engineer, ONE, `scenario:${scenario?.id}`, before)).data.unresolved[0]
        .reason,
    ).toBe('not_yet_known');
    const reached = await resolve(PERSONAS.engineer, ONE, `scenario:${scenario?.id}`, at);
    expect(reached.data.items).toHaveLength(1);
  });
});

describe('what a request leaves behind', () => {
  it('writes nothing, audits nothing and keeps case text out of the logs', async () => {
    const found = evidence.find(
      (item) => item.sourceRef.field === 'body' && item.excerpt.includes('roughly 140 users'),
    ) as Evidence;
    const repos = h.repos(CONTOSO);
    const auditBefore = (await repos.audit.list({ limit: 200 })).items.length;
    const runBefore = await repos.analysis.getLatestRun(ONE);
    const logsBefore = h.logs().length;

    const res = await resolve(PERSONAS.engineer, ONE, [
      `evidence:${found.id}`,
      `event:${oneEvents[0]?.id}`,
    ]);
    expect(res.statusCode).toBe(200);
    const quoted: string[] = [
      res.data.items[0].source.context.before,
      res.data.items[0].source.context.match,
      res.data.items[0].source.context.after,
      res.data.items[0].source.excerpt,
      res.data.items[0].event.title,
      oneEvents[0]?.title ?? '',
      oneEvents[0]?.body.slice(0, 40) ?? '',
    ];

    expect((await repos.audit.list({ limit: 200 })).items).toHaveLength(auditBefore);
    expect(await repos.analysis.getLatestRun(ONE)).toEqual(runBefore);
    const written = JSON.stringify(h.logs().slice(logsBefore));
    for (const text of quoted) {
      expect(written, text).not.toContain(text.trim().slice(0, 30).replaceAll('\n', '\\n'));
    }
  });
});
