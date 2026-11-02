/* eslint-disable @typescript-eslint/no-unsafe-return -- response bodies are parsed JSON, typed `Json` by the harness */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeBundle } from '@caseguard/domain';
import { ROUTES, SkillOverlaySchema, type CaseBundle, type Range } from '@caseguard/schemas';
import { ROLE_PERMISSIONS } from '@caseguard/security';
import type { Database } from '../src/db';
import {
  CONTOSO,
  PERSONAS,
  createHarness,
  openSharedDatabase,
  type ApiResponse,
  type Harness,
  type Json,
} from './support/app-harness';
import { contextFor } from './support/context';
import { SAMPLE_FILES, loadSampleBundle, toIngestInput } from './support/samples';
import { auditRecommendations, resolveAll } from './recommendations-support';
import {
  acceptScenario,
  allAuditEvents,
  apiOf,
  earliestForkScenarios,
  ingestAndAnalyse,
  settledJob,
  walkToPilot,
  type TestApi,
} from './skills-support';
import { findLeaks, leakProbe } from './views-support';

/*
 * `skillOverlay.get`, driven through HTTP with the real personas on the demo story: a skill is extracted from
 * Case One (a reviewer accepted the better path, the gates were passed) and it resembles Case Two. The
 * overlay is a comparison laid over the analysis: these tests prove it is built from what is stored, shows
 * the engine's own figures and the skill's own estimate with a formula a person can follow, never shows what
 * a record that is not whole has not yet produced, and changes nothing (the database is byte-identical
 * before and after, no audit event is recorded, applying a skill stays a separate explicit step).
 */

const ONE = 'case_overlay_one';
const TWO = 'case_overlay_two';

let database: Database;
let h: Harness;
let api: TestApi;
let skillId = '';
let forkId = '';
let content: Json;

const overlayUrl = (caseId: string, matchId: string, asOf?: string): string =>
  `/cases/${caseId}/skill-matches/${matchId}/overlay${asOf === undefined ? '' : `?asOf=${encodeURIComponent(asOf)}`}`;

/** The matches of a case, whole or as of a moment, as the list route answers them. */
async function matchesOf(caseId: string, asOf?: string): Promise<Json[]> {
  const res = await api.get(
    PERSONAS.engineer,
    `/cases/${caseId}/skill-matches${asOf === undefined ? '' : `?asOf=${encodeURIComponent(asOf)}`}`,
  );
  if (res.statusCode !== 200) throw new Error(`matches of ${caseId}: HTTP ${res.statusCode}`);
  return res.data.items;
}

async function matchOf(caseId: string, asOf?: string): Promise<Json> {
  const found = (await matchesOf(caseId, asOf)).find((match) => match.skillId === skillId);
  if (found === undefined) throw new Error(`the skill does not match ${caseId}`);
  return found;
}

/** Calls the route and checks every 200 answer against the contract. */
async function overlayOf(
  persona: string | null,
  caseId: string,
  matchId: string,
  asOf?: string,
): Promise<ApiResponse> {
  const res = await api.get(persona, overlayUrl(caseId, matchId, asOf));
  if (res.statusCode === 200) expect(() => SkillOverlaySchema.parse(res.data)).not.toThrow();
  return res;
}

const row = (overlay: Json, key: string): Json => {
  const found = (overlay.comparison as Json[]).find((candidate) => candidate.key === key);
  if (found === undefined) throw new Error(`no row ${key}`);
  return found;
};

const round1 = (value: number): number => Math.round(value * 10) / 10;
const minus = (recorded: Range, saved: Range): Range => ({
  low: round1(Math.max(0, recorded.low - saved.high)),
  mid: round1(Math.max(0, recorded.mid - saved.mid)),
  high: round1(Math.max(0, recorded.high - saved.low)),
});

/**
 * Every table of the database as a row count and a digest of its rows: what a read must leave as it was. On a real
 * server each test file migrates a private schema of its own, so the tables are the ones of the current schema.
 */
async function databaseDigest(): Promise<Record<string, string>> {
  const tables = await h.infra.database.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename`,
  );
  const digest: Record<string, string> = {};
  for (const { tablename } of tables.rows) {
    const result = await h.infra.database.query<{ n: number; d: string }>(
      `SELECT count(*)::int AS n, md5(coalesce(string_agg(t::text, ',' ORDER BY t::text), '')) AS d FROM "${tablename}" t`,
    );
    digest[tablename] = `${result.rows[0]?.n}:${result.rows[0]?.d}`;
  }
  return digest;
}

beforeAll(async () => {
  database = await openSharedDatabase();
  h = await createHarness({ database });
  api = apiOf(h);
  await ingestAndAnalyse(h, { one: ONE, two: TWO });

  // The path of the story: the reviewer accepts the better path of Case One's earliest decision point, a
  // skill is extracted from it and walked through the gates to the pilot, where it can be matched.
  const found = await earliestForkScenarios(h, api, ONE);
  forkId = found.forkId;
  const balanced = found.scenarios.find((scenario) => scenario.strategy === 'balanced');
  const accepted = await acceptScenario(api, ONE, balanced);
  if (accepted.statusCode !== 200) throw new Error(`accept: HTTP ${accepted.statusCode}`);
  const started = await api.post(PERSONAS.engineer, `/cases/${ONE}/skills/extract`, {
    scenarioId: balanced?.id,
  });
  if (started.statusCode !== 202) throw new Error(`extract: HTTP ${started.statusCode}`);
  const job = await settledJob(h, api, started.data.job.id);
  if (job.status !== 'succeeded') throw new Error(`extraction: ${JSON.stringify(job.error)}`);
  skillId = job.resultRef.id;
  await walkToPilot(h, api, skillId);
  content = (await api.get(PERSONAS.engineer, `/skills/${skillId}`)).data.currentVersion.content;

  // As in the story, both cases are analysed again once the skill library holds the skill: a whole-case
  // match is stored with the analysis, so the overlay is read where a person would read it.
  for (const caseId of [ONE, TWO]) {
    const again = await api.post(PERSONAS.engineer, `/cases/${caseId}/analysis`, {});
    if (again.statusCode !== 202)
      throw new Error(`analysis of ${caseId}: HTTP ${again.statusCode}`);
    const rerun = await settledJob(h, api, again.data.job.id);
    if (rerun.status !== 'succeeded') throw new Error(`analysis: ${JSON.stringify(rerun.error)}`);
  }
}, 900_000);

afterAll(async () => {
  await h.close();
  await database.close();
});

describe('Case One: the case the skill was distilled from, the whole record', () => {
  let overlay: Json;
  let match: Json;
  beforeAll(async () => {
    match = await matchOf(ONE);
    const res = await overlayOf(PERSONAS.engineer, ONE, match.id);
    expect(res.statusCode).toBe(200);
    overlay = res.data;
  });

  it('is about this match and says what it is: an estimate, with the recorded analysis unchanged', () => {
    expect(overlay).toMatchObject({
      caseId: ONE,
      matchId: match.id,
      asOf: match.asOf,
      score: match.score,
      applicability: match.applicability,
      applied: false,
      skill: {
        id: skillId,
        versionId: match.versionId,
        name: match.skillName,
        version: match.skillVersion,
        lifecycle: 'pilot',
      },
      labels: { estimated: true, simulated: true, recordedAnalysisUnchanged: true },
    });
    expect(overlay.withSkill.steps).toEqual(match.recommendedSteps);
  });

  it('puts the decision point the skill was distilled from, and what the case did there, beside the plan', () => {
    const earliest = overlay.decisionPoint;
    expect(earliest).toMatchObject({
      forkId,
      title: expect.any(String),
      summary: expect.any(String),
    });
    expect(content.provenance.forkId).toBe(forkId);
    expect(overlay.recorded.actionKey).not.toBeNull();
    expect(overlay.recorded.actionLabel).not.toBeNull();
    const firstStep = (match.recommendedSteps as Json[]).find((step) => step.actionKey !== null);
    expect(overlay.recorded.followedRecommendedStep).toBe(firstStep?.status === 'done');
    expect(overlay.recorded.note).toContain(overlay.recorded.actionLabel);
  });

  it('shows the engine’s own figures for the recorded path, the skill’s own saving, and the arithmetic between them', async () => {
    const stored = (await h.repos(CONTOSO).counterfactuals.list(ONE, { forkId })).filter(
      (scenario) => scenario.status === 'completed',
    );
    expect(stored.length).toBeGreaterThan(0);
    // The recorded path does not depend on the strategy of a simulation.
    for (const scenario of stored) expect(scenario.actualMetrics).toEqual(stored[0]?.actualMetrics);
    const actual = stored[0]?.actualMetrics;
    if (actual === undefined)
      throw new Error('the engine stored no simulation of the decision point');
    const benefit = content.expectedBenefit;
    expect(benefit.estimated).toBe(true);
    expect(overlay.comparison.map((r: Json) => r.key)).toEqual([
      'time_to_diagnosis_minutes',
      'time_to_useful_evidence_minutes',
      'customer_effort_minutes',
      'tokens',
    ]);

    const expected: [string, Range, Range][] = [
      ['time_to_diagnosis_minutes', actual.timeToDiagnosisMinutes, benefit.timeSavedMinutes],
      ['customer_effort_minutes', actual.customerEffortMinutes, benefit.customerEffortSavedMinutes],
      ['tokens', actual.tokenEstimate, benefit.tokensSaved],
    ];
    for (const [key, recorded, saved] of expected) {
      const found = row(overlay, key);
      expect(found.recorded, key).toEqual(recorded);
      expect(found.saved, key).toEqual(saved);
      expect(found.withSkill, key).toEqual(minus(recorded, saved));
      expect(found.basis, key).toContain('recorded minus the skill’s own estimated saving');
    }
    expect(row(overlay, 'time_to_diagnosis_minutes')).toMatchObject({ unit: 'minutes' });
    expect(row(overlay, 'tokens')).toMatchObject({ unit: 'tokens' });
    // The skill states no saving in time to useful evidence, so that figure is shown as recorded and no more.
    expect(row(overlay, 'time_to_useful_evidence_minutes')).toMatchObject({
      recorded: actual.timeToUsefulEvidenceMinutes,
      saved: null,
      withSkill: null,
    });
  });

  it('says in plain words what it assumes and where it does not reach', () => {
    expect(overlay.assumptions.join(' ')).toMatch(/estimate/);
    expect(overlay.assumptions.join(' ')).toContain(content.expectedBenefit.basis);
    expect(overlay.limitations).toEqual(
      expect.arrayContaining([
        ...content.applicability.limitations,
        ...content.expectedBenefit.caveats,
      ]),
    );
    expect(overlay.limitations.join(' ')).toMatch(/applies nothing/);
  });

  it('names evidence and the decision point that the provenance route resolves, every one of them', async () => {
    expect(overlay.evidence.length).toBeGreaterThan(1);
    expect(overlay.evidence.at(-1)).toMatchObject({ type: 'fork', id: forkId });
    const matched = new Set(
      (match.matchedTriggers as Json[]).flatMap((trigger) => trigger.evidenceIds as string[]),
    );
    for (const link of overlay.evidence.slice(0, -1)) {
      expect(link.type).toBe('evidence');
      expect(matched.has(link.id)).toBe(true);
    }
    const { unresolved, items } = await resolveAll(h, ONE, overlay.evidence);
    expect(unresolved).toEqual([]);
    expect(items).toHaveLength(overlay.evidence.length);
  });
});

describe('Case Two: the skill from Case One resembles it (the demo story)', () => {
  it('has no decision point to compare, says the engineer already took the first step, and shows only the skill’s own estimate', async () => {
    const match = await matchOf(TWO);
    expect(match).toMatchObject({ applicability: 'applies', applied: false });
    const res = await overlayOf(PERSONAS.engineer, TWO, match.id);
    expect(res.statusCode).toBe(200);
    const overlay = res.data;
    expect(overlay.decisionPoint).toBeNull();
    expect(overlay.recorded).toMatchObject({
      actionKey: null,
      actionLabel: null,
      followedRecommendedStep: true,
    });
    expect(overlay.recorded.note).toMatch(/no decision point/);
    for (const found of overlay.comparison as Json[]) {
      expect(found.recorded).toBeNull();
      expect(found.withSkill).toBeNull();
      expect(found.basis).toMatch(/No decision point/);
    }
    expect(row(overlay, 'time_to_diagnosis_minutes').saved).toEqual(
      content.expectedBenefit.timeSavedMinutes,
    );
    expect(row(overlay, 'tokens').saved).toEqual(content.expectedBenefit.tokensSaved);
    expect(overlay.evidence.every((link: Json) => link.type === 'evidence')).toBe(true);
    expect((await resolveAll(h, TWO, overlay.evidence)).unresolved).toEqual([]);
  });

  it('as of its first email recommends the first step and never shows what the case did later', async () => {
    const repos = h.repos(CONTOSO);
    const [events, resolution, record] = await Promise.all([
      repos.cases.getAllEvents(TWO),
      repos.cases.getResolution(TWO),
      repos.cases.get(TWO),
    ]);
    const first = events[0]?.timestamp ?? '';
    const whole = await matchOf(TWO);
    const early = await matchOf(TWO, first);
    expect(early.id).toBe(whole.id);

    const res = await overlayOf(PERSONAS.engineer, TWO, early.id, first);
    expect(res.statusCode).toBe(200);
    const overlay = res.data;
    expect(overlay.asOf).toBe(first);
    expect(overlay.applicability).toBe('applies');
    expect(overlay.recorded.followedRecommendedStep).toBe(false);
    expect(overlay.withSkill.steps[0]).toMatchObject({ status: 'recommended_next' });
    expect(overlay.withSkill.steps).toEqual(early.recommendedSteps);
    for (const found of overlay.comparison as Json[]) {
      expect(found.recorded).toBeNull();
      expect(found.withSkill).toBeNull();
    }
    expect(overlay.recorded.note).toContain('has not taken that step yet');

    // The skill's own wording existed before the case did, so it is known whatever the case says later.
    const probe = leakProbe(events, resolution, first, record?.workload ?? '', {
      extraKnownText: `${record?.title ?? ''} ${(record?.tags ?? []).join(' ')} ${JSON.stringify(content)}`,
    });
    expect(probe.laterEventIds.length).toBeGreaterThan(0);
    expect(findLeaks(JSON.stringify(overlay), probe)).toEqual([]);
    // Everything it names was known by then.
    expect((await resolveAll(h, TWO, overlay.evidence, first)).unresolved).toEqual([]);
  });

  it('as of the whole record and beyond it is the same overlay; before the first event the skill cannot apply', async () => {
    const repos = h.repos(CONTOSO);
    const events = await repos.cases.getAllEvents(TWO);
    const last = events[events.length - 1]?.timestamp ?? '';
    const match = await matchOf(TWO);
    const whole = (await overlayOf(PERSONAS.engineer, TWO, match.id)).data;
    const beyond = await overlayOf(PERSONAS.engineer, TWO, match.id, '2099-01-01T00:00:00Z');
    expect(beyond.statusCode).toBe(200);
    expect(beyond.data.asOf).toBe(last);
    expect(beyond.data).toEqual(whole);

    const before = await overlayOf(PERSONAS.engineer, TWO, match.id, '2000-01-01T00:00:00Z');
    expect(before.statusCode).toBe(200);
    expect(before.data).toMatchObject({
      applicability: 'not_applicable',
      score: 0,
      decisionPoint: null,
    });
    for (const found of before.data.comparison as Json[]) expect(found.withSkill).toBeNull();
  });

  it('never shows a skill extracted from a case as of an earlier moment of that case (it would carry hindsight)', async () => {
    const match = await matchOf(ONE);
    const events = await h.repos(CONTOSO).cases.getAllEvents(ONE);
    const early = events[2]?.timestamp ?? '';
    expect((await matchesOf(ONE, early)).map((m) => m.skillId)).not.toContain(skillId);
    const res = await overlayOf(PERSONAS.engineer, ONE, match.id, early);
    expect(res.statusCode).toBe(404);
    expect(res.data.code).toBe('not_found');
  });
});

describe('another case like Case One: the skill’s saving is assumed to carry over', () => {
  const COPY = 'case_overlay_copy';
  let whole: Json;

  /** A copy of Case One under another reference: the same record, a case the skill was not distilled from. */
  beforeAll(async () => {
    const original = loadSampleBundle(SAMPLE_FILES.caseOne);
    const copy: CaseBundle = { ...original, case: { ...original.case, reference: 'CG-SYN-1911' } };
    const payload = JSON.stringify(copy);
    const normalized = normalizeBundle(copy, {
      tenantId: CONTOSO,
      caseId: COPY,
      sourceId: `src_${COPY}`,
      createdBy: 'system:test',
      now: '2026-10-29T00:00:00.000Z',
      sourceKind: 'builtin_sample',
      storedPayload: payload,
      redactionReplacements: 0,
    });
    await h.repos(CONTOSO).cases.ingest(toIngestInput(normalized, payload));
    const engineer = contextFor(h, PERSONAS.engineer);
    await engineer.services.analysis.analyzeCase(engineer, COPY);
    h.clock.advance(61_000);
    const match = await matchOf(COPY);
    whole = (await overlayOf(PERSONAS.engineer, COPY, match.id)).data;
  }, 300_000);

  it('compares the same recorded path with the same estimate, and says the saving is assumed to carry over', async () => {
    const source = (await overlayOf(PERSONAS.engineer, ONE, (await matchOf(ONE)).id)).data;
    expect(whole.decisionPoint).not.toBeNull();
    expect(whole.decisionPoint.forkId).not.toBe(forkId);
    expect(whole.decisionPoint.title).toBe(source.decisionPoint.title);
    expect(whole.recorded.actionKey).toBe(source.recorded.actionKey);
    // The same record gives the engine the same figures, so the same arithmetic.
    expect(whole.comparison).toEqual(source.comparison);
    expect(whole.assumptions.join(' ')).toContain('assumed to carry over');
    expect(whole.assumptions.join(' ')).not.toContain('the skill’s own replay');
    expect(source.assumptions.join(' ')).toContain('the skill’s own replay');
  });

  it('as of the decision, names it and what the case did there, and shows no figure of the path that follows', async () => {
    const repos = h.repos(CONTOSO);
    const [events, resolution, record] = await Promise.all([
      repos.cases.getAllEvents(COPY),
      repos.cases.getResolution(COPY),
      repos.cases.get(COPY),
    ]);
    const at: string = whole.decisionPoint.at;
    const match = await matchOf(COPY, at);
    const res = await overlayOf(PERSONAS.engineer, COPY, match.id, at);
    expect(res.statusCode).toBe(200);
    const early = res.data;
    expect(early.asOf).toBe(match.asOf);
    expect(early.decisionPoint).toMatchObject({
      forkId: whole.decisionPoint.forkId,
      eventId: whole.decisionPoint.eventId,
      at: whole.decisionPoint.at,
      title: whole.decisionPoint.title,
    });
    expect(early.recorded.actionKey).toBe(whole.recorded.actionKey);
    expect(early.recorded.followedRecommendedStep).toBe(false);
    for (const found of early.comparison as Json[]) {
      expect(found.recorded).toBeNull();
      expect(found.withSkill).toBeNull();
      expect(found.basis).toMatch(/whole record is visible/);
    }
    expect(early.limitations.join(' ')).toMatch(/only once the whole record is visible/);

    // None of what the case did after the decision is shown, and everything it names was known by then.
    const probe = leakProbe(events, resolution, at, record?.workload ?? '', {
      extraKnownText: `${record?.title ?? ''} ${(record?.tags ?? []).join(' ')} ${JSON.stringify(content)}`,
    });
    expect(probe.laterEventIds.length).toBeGreaterThan(0);
    expect(findLeaks(JSON.stringify(early), probe)).toEqual([]);
    expect((await resolveAll(h, COPY, early.evidence, at)).unresolved).toEqual([]);

    // From the last event on it is the whole record again, and the figures are there.
    const last = events[events.length - 1]?.timestamp ?? '';
    const complete = await overlayOf(PERSONAS.engineer, COPY, match.id, last);
    expect(complete.data.comparison).toEqual(whole.comparison);
    // One event short of it they are still withheld.
    const before = events[events.length - 2]?.timestamp ?? '';
    const almost = await overlayOf(PERSONAS.engineer, COPY, match.id, before);
    expect(almost.statusCode).toBe(200);
    for (const found of almost.data.comparison as Json[]) expect(found.recorded).toBeNull();
  });
});

describe('what the overlay changes: nothing', () => {
  // Every pass the engine runs for an instant is metered per caller; a minute later the bucket is full again.
  beforeAll(() => {
    h.clock.advance(61_000);
  });

  const calls = async (): Promise<void> => {
    const one = await matchOf(ONE);
    const two = await matchOf(TWO);
    const events = await h.repos(CONTOSO).cases.getAllEvents(TWO);
    for (const persona of [PERSONAS.engineer, PERSONAS.manager, PERSONAS.reviewer]) {
      expect((await overlayOf(persona, ONE, one.id)).statusCode).toBe(200);
      expect((await overlayOf(persona, TWO, two.id)).statusCode).toBe(200);
    }
    for (const event of events.slice(0, 4)) {
      expect((await overlayOf(PERSONAS.engineer, TWO, two.id, event.timestamp)).statusCode).toBe(
        200,
      );
    }
    expect((await overlayOf(PERSONAS.engineer, TWO, 'missing_match')).statusCode).toBe(404);
  };

  /** The stored analysis and the match lists, as the API answers them. */
  async function stored(): Promise<Json> {
    const out: Json = {};
    for (const caseId of [ONE, TWO]) {
      for (const path of ['quality', 'forks', 'metrics', 'warnings?state=all', 'coaching']) {
        out[`${caseId}/${path}`] = (
          await api.get(PERSONAS.engineer, `/cases/${caseId}/${path}`)
        ).data;
      }
      out[`${caseId}/matches`] = await matchesOf(caseId);
    }
    return out;
  }

  it('leaves the database, the stored analysis and the match lists exactly as they were, and records no audit event', async () => {
    const digestBefore = await databaseDigest();
    // Case One, Case Two and the copy of Case One: the digest sees every row, so a pass here is not vacuous.
    expect(digestBefore['cases']).toMatch(/^3:/);
    expect(Number(digestBefore['evidence']?.split(':')[0])).toBeGreaterThan(0);
    const storedBefore = JSON.stringify(await stored());
    const auditBefore = (await allAuditEvents(h)).length;
    const matchesStoredBefore = await h.repos(CONTOSO).skills.listMatchesForCase(TWO);
    const logsBefore = h.logs().length;

    await calls();

    expect(await databaseDigest()).toEqual(digestBefore);
    expect(JSON.stringify(await stored())).toBe(storedBefore);
    expect((await allAuditEvents(h)).length).toBe(auditBefore);
    expect(await h.repos(CONTOSO).skills.listMatchesForCase(TWO)).toEqual(matchesStoredBefore);

    // And no case text reaches the logs: they carry ids and statuses.
    const events = await h.repos(CONTOSO).cases.getAllEvents(TWO);
    const written = JSON.stringify(h.logs().slice(logsBefore));
    for (const event of events) {
      const text = (event.body || event.title || '').trim().slice(0, 30);
      if (text.length >= 20 && !/["\\\n]/.test(text)) expect(written).not.toContain(text);
    }
  });

  it(
    'leaves applying a skill an explicit, audited step of its own: the overlay never applies it',
    { timeout: 120_000 },
    async () => {
      const match = await matchOf(TWO);
      const before = (await allAuditEvents(h)).filter((event) => event.action === 'skill.applied');

      const applied = await api.post(
        PERSONAS.engineer,
        `/cases/${TWO}/skill-matches/${match.id}/apply`,
      );
      expect(applied.statusCode).toBe(200);
      expect(applied.data).toMatchObject({ applied: true, appliedBy: PERSONAS.engineer });
      const after = (await allAuditEvents(h)).filter((event) => event.action === 'skill.applied');
      expect(after).toHaveLength(before.length + 1);

      // The overlay now says it was adopted and, still, changes nothing.
      const digest = await databaseDigest();
      const res = await overlayOf(PERSONAS.engineer, TWO, match.id);
      expect(res.statusCode).toBe(200);
      expect(res.data.applied).toBe(true);
      expect(await databaseDigest()).toEqual(digest);
      expect(
        (await allAuditEvents(h)).filter((event) => event.action === 'skill.applied'),
      ).toHaveLength(after.length);
    },
  );
});

describe('who may read it, and where', () => {
  it('is skill:read, which every role holds, and nobody without a login or from another tenant may read it', async () => {
    expect(ROUTES['skillOverlay.get'].permission).toBe('skill:read');
    for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
      expect(permissions, role).toContain('skill:read');
    }
    const match = await matchOf(TWO);
    for (const persona of [
      PERSONAS.engineer,
      PERSONAS.reviewer,
      PERSONAS.manager,
      PERSONAS.curator,
      PERSONAS.admin,
    ]) {
      expect((await overlayOf(persona, TWO, match.id)).statusCode, persona).toBe(200);
    }
    expect((await overlayOf(null, TWO, match.id)).statusCode).toBe(401);
    // Another tenant's person gets the same answer as for a case that does not exist.
    const foreign = await overlayOf(PERSONAS.otherTenantEngineer, TWO, match.id);
    const missing = await overlayOf(PERSONAS.otherTenantEngineer, 'case_never_existed', match.id);
    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(foreign.data.code).toBe('not_found');
    expect(foreign.data.code).toBe(missing.data.code);
    expect(JSON.stringify(foreign.data)).not.toMatch(/CG-SYN-1002|Teams|proxy/i);
  });

  it('answers an unknown match or case with 404 and malformed input with 422, naming no case text', async () => {
    const match = await matchOf(TWO);
    expect((await overlayOf(PERSONAS.engineer, TWO, 'match_never_existed')).statusCode).toBe(404);
    expect((await overlayOf(PERSONAS.engineer, 'case_never_existed', match.id)).statusCode).toBe(
      404,
    );
    // A match of another case is not a match of this one.
    const other = await matchOf(ONE);
    expect(other.id).not.toBe(match.id);
    expect((await overlayOf(PERSONAS.engineer, TWO, other.id)).statusCode).toBe(404);

    for (const bad of ['has%20space', '%3Cscript%3E']) {
      const res = await api.get(PERSONAS.engineer, `/cases/${TWO}/skill-matches/${bad}/overlay`);
      expect(res.statusCode, bad).toBe(422);
      expect(res.data.code).toBe('validation_failed');
    }
    for (const asOf of ['yesterday', '2026-13-45']) {
      const res = await api.get(
        PERSONAS.engineer,
        `${overlayUrl(TWO, match.id)}?asOf=${encodeURIComponent(asOf)}`,
      );
      expect(res.statusCode, asOf).toBe(422);
    }
  });
});

describe('the demo story: every recommendation stays checkable', () => {
  it(
    'cites its basis, and every link resolves and every citation of text verifies, once the skill exists',
    { timeout: 300_000 },
    async () => {
      // The two cases were analysed again after the skill was extracted and taken to the pilot; the stored
      // recommendations are the ones a person reads at the end of the story.
      for (const caseId of [ONE, TWO])
        expect(await auditRecommendations(h, caseId), caseId).toEqual([]);
    },
  );
});
