import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeBundle, verifyExcerpt } from '@caseguard/domain';
import {
  RECORD_FINDINGS_LIMIT,
  RecordFindingsSchema,
  SET_ASIDE_LIMIT,
  type CaseEvent,
  type RecordFindings,
} from '@caseguard/schemas';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import {
  CONTOSO,
  PERSONAS,
  createHarness,
  openSharedDatabase,
  type ApiResponse,
  type Harness,
} from './support/app-harness';
import { contextFor } from './support/context';
import { SAMPLE_FILES, ingestSample, loadSampleBundle, toIngestInput } from './support/samples';
import { eventBySuffix } from './views-support';

const ONE = 'case_rf_one';
const TWO = 'case_rf_two';
const CLASH = 'case_rf_clash';

let database: Database;
let h: Harness;
let oneEvents: CaseEvent[];
let clashEvents: CaseEvent[];

/**
 * Case Two with a later statement of how many users are affected that disagrees with the first, and a denial that
 * the detectors read and set aside.
 */
async function ingestClash(): Promise<CaseEvent[]> {
  const bundle = structuredClone(loadSampleBundle(SAMPLE_FILES.caseTwo));
  bundle.case.reference = 'CG-SYN-1902';
  const later = bundle.events.find((event) => event.id === 'g12');
  if (later === undefined) throw new Error('Case Two has no event g12');
  later.body = later.body.replace(
    'Our helpdesk has had no sign-in tickets since 11:45 UTC.',
    'Our helpdesk now counts 300 users at our Rotterdam site who were affected, and no sign-in tickets since 11:45 UTC. This is not just one user.',
  );
  const payload = JSON.stringify(bundle);
  const normalized = normalizeBundle(bundle, {
    tenantId: CONTOSO,
    caseId: CLASH,
    sourceId: `src_${CLASH}`,
    createdBy: 'system:test',
    now: '2026-10-29T00:00:00.000Z',
    sourceKind: 'builtin_sample',
    storedPayload: payload,
    redactionReplacements: 0,
  });
  await h.repos(CONTOSO).cases.ingest(toIngestInput(normalized, payload));
  return normalized.events;
}

async function findings(
  persona: string | null,
  caseId: string,
  asOf?: string,
): Promise<ApiResponse> {
  const res = await h.call(persona, {
    method: 'GET',
    url: `/api/v1/cases/${caseId}/record-findings${asOf === undefined ? '' : `?asOf=${encodeURIComponent(asOf)}`}`,
  });
  if (res.statusCode === 200) expect(() => RecordFindingsSchema.parse(res.data)).not.toThrow();
  return res;
}

/** Every event id a response names, wherever it is. */
function eventIdsIn(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => eventIdsIn(item, found));
  else if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (key === 'eventId' && typeof inner === 'string') found.add(inner);
      else eventIdsIn(inner, found);
    }
  }
  return found;
}

beforeAll(async () => {
  database = await openSharedDatabase();
  h = await createHarness({ database });
  const repos = h.repos(CONTOSO);
  const one = await ingestSample(repos, SAMPLE_FILES.caseOne, { tenantId: CONTOSO, caseId: ONE });
  await ingestSample(repos, SAMPLE_FILES.caseTwo, { tenantId: CONTOSO, caseId: TWO });
  oneEvents = one.events;
  clashEvents = await ingestClash();

  const engineer = contextFor(h, PERSONAS.engineer);
  for (const caseId of [ONE, TWO, CLASH]) {
    await h.infra.services.analysis.analyzeCase(engineer, caseId);
  }
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);

afterAll(async () => {
  await h.close();
  await database.close();
});

describe('record findings: what the record itself shows', () => {
  it('answers the contract for both samples, without naming an instant', async () => {
    for (const caseId of [ONE, TWO]) {
      const res = await findings(PERSONAS.engineer, caseId);
      expect(res.statusCode, caseId).toBe(200);
      const body = res.data as unknown as RecordFindings;
      expect(body.asOf).toBeNull();
      expect(body.conflicts.length).toBeLessThanOrEqual(RECORD_FINDINGS_LIMIT);
      expect(body.setAside.length).toBeLessThanOrEqual(SET_ASIDE_LIMIT);
      expect(body.setAsideTotal).toBeGreaterThanOrEqual(body.setAside.length);
    }
  });

  it('Case One names its earliest missed moment, anchored at an event of the case', async () => {
    const body = (await findings(PERSONAS.engineer, ONE)).data as unknown as RecordFindings;
    const missed = body.sequenceFindings.find((f) => f.rule === 'earliest_missed_moment');
    expect(missed).toBeDefined();
    const ids = new Set(oneEvents.map((event) => event.id));
    for (const finding of body.sequenceFindings) {
      for (const event of finding.events) expect(ids.has(event.eventId), finding.rule).toBe(true);
      // A finding is about an instant, and everything it names was recorded by then.
      for (const event of finding.events)
        expect(event.timestamp <= finding.asOf, finding.rule).toBe(true);
    }
  });

  it('two statements of how many users are affected that disagree are one conflict with both sides, each quoting the record', async () => {
    const body = (await findings(PERSONAS.engineer, CLASH)).data as unknown as RecordFindings;
    const first = eventBySuffix(clashEvents, 'g01');
    const later = eventBySuffix(clashEvents, 'g12');
    // The later message also says "no sign-in tickets since 11:45 UTC": a denial, not a second start of the failures.
    expect(body.conflicts).toHaveLength(1);
    const [conflict] = body.conflicts;
    expect(conflict).toMatchObject({
      subject: 'Number of affected users',
      class: 'temporal_update',
      favours: 'second',
    });
    expect(conflict?.sides.map((side) => side.eventId)).toEqual([first.id, later.id]);
    for (const side of conflict?.sides ?? []) {
      const event = clashEvents.find((candidate) => candidate.id === side.eventId);
      expect(event).toBeDefined();
      if (event === undefined) continue;
      expect(verifyExcerpt(event, side.sourceRef).verification, side.eventId).toBe('verified');
    }
    expect(conflict?.uncertainty.note.length).toBeGreaterThan(0);
  });

  it('as of an instant before the later statement there is no conflict, and nothing later is named anywhere', async () => {
    const first = eventBySuffix(clashEvents, 'g01');
    const later = eventBySuffix(clashEvents, 'g12');
    const before = eventBySuffix(clashEvents, 'g11');
    const early = await findings(PERSONAS.engineer, CLASH, before.timestamp);
    expect(early.statusCode).toBe(200);
    const body = early.data as unknown as RecordFindings;
    expect(body.conflicts).toEqual([]);
    const byId = new Map(clashEvents.map((event) => [event.id, event]));
    for (const id of eventIdsIn(early.data)) {
      expect(
        (byId.get(id)?.timestamp ?? '') <= before.timestamp,
        `${id} is later than the instant`,
      ).toBe(true);
    }
    expect(eventIdsIn(early.data).has(later.id)).toBe(false);

    const whole = await findings(PERSONAS.engineer, CLASH, later.timestamp);
    const conflict = (whole.data as unknown as RecordFindings).conflicts[0];
    expect(conflict?.sides[0].eventId).toBe(first.id);
  });

  it('lists the words it read and did not count, with the cue that decided it, and keeps the true total', async () => {
    const later = eventBySuffix(clashEvents, 'g12');
    const body = (await findings(PERSONAS.engineer, CLASH)).data as unknown as RecordFindings;
    const note = body.setAside.find((n) => n.signalId === 'sig.single-user-scope');
    expect(note).toMatchObject({ eventId: later.id, modality: 'negated' });
    expect(note?.excerpt).toMatch(/not just one user/i);
    expect(note?.cue).toMatch(/not/i);
    expect(note?.signalLabel.length).toBeGreaterThan(0);
    for (const each of body.setAside) expect(each.modality).not.toBe('asserted');
    expect(body.setAsideTotal).toBeGreaterThanOrEqual(body.setAside.length);
    expect(body.setAsideTotal).toBeGreaterThan(0);
  });
});
