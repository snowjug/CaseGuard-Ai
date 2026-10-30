import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  analyzeView,
  buildDigitalTwin,
  computeQualityReview,
  createTemporalView,
  getCompiledPack,
  replayWarnings,
  round,
  runDeterministicAnalysis,
  toBreakdowns,
  type CompiledPack,
  type DeterministicAnalysis,
  type EngineContext,
} from '@caseguard/domain';
import {
  DEFAULT_ACTION_VALUE_CONFIG,
  DEFAULT_QUALITY_CONFIG,
  type Case,
  type CaseEvent,
  type CaseResolution,
} from '@caseguard/schemas';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import { ENGINE_BUDGET_WINDOW_MS, engineBudgetFor } from '../src/services/engine-budget';
import { ViewCache, viewDepsFor } from '../src/services/views';
import { loadViewState } from '../src/services/views/state';
import {
  CONTOSO,
  FABRIKAM,
  PERSONAS,
  createHarness,
  openSharedDatabase,
  type Harness,
} from './support/app-harness';
import { contextFor } from './support/context';
import { SAMPLE_FILES, ingestSample } from './support/samples';
import {
  AS_OF_SUFFIXES,
  eventBySuffix,
  eventsAfter,
  eventsUpTo,
  findLeaks,
  leakProbe,
} from './views-support';

const ONE = 'case_views_temporal_one';
const TWO = 'case_views_temporal_two';

let database: Database;
let h: Harness;
let events: CaseEvent[];
let resolution: CaseResolution | null;
let caseRecord: Case;
let workload: string;
let pack: CompiledPack;

const refCtx: EngineContext = {
  tenantId: CONTOSO,
  caseId: ONE,
  runId: 'run_reference',
  now: '2026-10-29T00:00:00.000Z',
  createdBy: 'system:test',
  seed: 'reference',
};

/** What the engine itself says about the case when it is shown only what was known at `asOf`. */
function freshAnalysis(asOf: string): DeterministicAnalysis {
  return runDeterministicAnalysis({
    view: createTemporalView(events, asOf, { resolution }),
    pack,
    config: DEFAULT_ACTION_VALUE_CONFIG,
    ctx: refCtx,
  });
}

beforeAll(async () => {
  database = await openSharedDatabase();
  h = await createHarness({ database });
  const one = await ingestSample(h.repos(CONTOSO), SAMPLE_FILES.caseOne, {
    tenantId: CONTOSO,
    caseId: ONE,
  });
  await ingestSample(h.repos(CONTOSO), SAMPLE_FILES.caseTwo, { tenantId: CONTOSO, caseId: TWO });
  events = one.events;
  resolution = one.resolution;
  caseRecord = one.case;
  workload = one.case.workload;
  const compiled = getCompiledPack(workload);
  if (compiled === null) throw new Error('The sample workload has no knowledge pack');
  pack = compiled;
  const ctx = contextFor(h, PERSONAS.engineer);
  await h.infra.services.analysis.analyzeCase(ctx, ONE);
  await h.infra.services.analysis.analyzeCase(ctx, TWO);
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);

afterAll(async () => {
  await h.close();
  await database.close();
});

/**
 * Every request starts with a full engine budget (the clock jumps a window), so the many instants
 * these tests scan are not throttled; the metering itself is tested on its own further down.
 */
const get = (url: string, persona: string | null = PERSONAS.reviewer) => {
  h.clock.advance(ENGINE_BUDGET_WINDOW_MS);
  return h.call(persona, { method: 'GET', url });
};

const base = `/api/v1/cases/${ONE}`;
const at = (asOf: string): string => `asOf=${encodeURIComponent(asOf)}`;

/** Every read view that accepts `asOf`, as a path and query for one instant. */
function asOfUrls(asOf: string): Record<string, string> {
  return {
    twin: `${base}/twin?${at(asOf)}`,
    timeline: `${base}/timeline?${at(asOf)}&limit=200`,
    evidence: `${base}/evidence?${at(asOf)}&limit=200`,
    hypotheses: `${base}/hypotheses?${at(asOf)}`,
    actions: `${base}/actions?${at(asOf)}`,
    actionValues: `${base}/action-values?${at(asOf)}`,
    forks: `${base}/forks?${at(asOf)}`,
    graph: `${base}/graph?${at(asOf)}`,
    quality: `${base}/quality?${at(asOf)}`,
    metrics: `${base}/metrics?${at(asOf)}`,
    warnings: `${base}/warnings?${at(asOf)}`,
  };
}

describe('temporal integrity: an as-of view never contains the future', () => {
  for (const suffix of AS_OF_SUFFIXES) {
    it(`[FR-TL-06] every view as of ${suffix} holds no later event id, instant or text`, async () => {
      const asOf = eventBySuffix(events, suffix).timestamp;
      const probe = leakProbe(events, resolution, asOf, workload);
      expect(probe.laterEventIds.length).toBeGreaterThan(0);
      expect(probe.laterTokens.length).toBeGreaterThan(0);

      const leaks: Record<string, string[]> = {};
      for (const [name, url] of Object.entries(asOfUrls(asOf))) {
        const res = await get(url);
        expect(res.statusCode, `${name}: ${res.body.slice(0, 300)}`).toBe(200);
        const found = findLeaks(res.body, probe);
        if (found.length > 0) leaks[name] = found;
      }

      // Every visible event, and the forks that exist by then, are served without the future too.
      for (const event of eventsUpTo(events, asOf)) {
        const res = await get(`${base}/events/${event.id}?${at(asOf)}`);
        expect(res.statusCode, event.id).toBe(200);
        const found = findLeaks(res.body, probe);
        if (found.length > 0) leaks[`event ${event.id}`] = found;
      }
      const forks = (await get(`${base}/forks?${at(asOf)}`)).data.items as { id: string }[];
      for (const fork of forks) {
        const res = await get(`${base}/forks/${fork.id}?${at(asOf)}`);
        expect(res.statusCode).toBe(200);
        const found = findLeaks(res.body, probe);
        if (found.length > 0) leaks[`fork ${fork.id}`] = found;
      }
      expect(leaks).toEqual({});
    });
  }

  it('has teeth: the whole-record views do contain what the probe looks for', async () => {
    const asOf = eventBySuffix(events, 'e03').timestamp;
    const probe = leakProbe(events, resolution, asOf, workload);
    for (const name of ['timeline', 'hypotheses', 'forks', 'graph']) {
      const url = `${base}/${name}`;
      const res = await get(url);
      expect(findLeaks(res.body, probe).length, name).toBeGreaterThan(0);
    }
  });

  it('withholds later events from the ledger across every page', async () => {
    const asOf = eventBySuffix(events, 'e07').timestamp;
    const probe = leakProbe(events, resolution, asOf, workload);
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await get(
        `${base}/evidence?${at(asOf)}&limit=5${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
      );
      expect(res.statusCode).toBe(200);
      expect(findLeaks(res.body, probe)).toEqual([]);
      for (const claim of res.data.items as { timestamp: string }[]) {
        expect(Date.parse(claim.timestamp)).toBeLessThanOrEqual(Date.parse(asOf));
      }
      cursor = res.data.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 50);
    expect(pages).toBeGreaterThan(1);
  });
});

describe('as-of views equal a fresh engine analysis of the same window', () => {
  for (const suffix of AS_OF_SUFFIXES) {
    it(`ranks hypotheses as a fresh analysis does as of ${suffix}`, async () => {
      const asOf = eventBySuffix(events, suffix).timestamp;
      const fresh = freshAnalysis(asOf);
      const expected = [...fresh.hypotheses]
        .sort(
          (a, b) =>
            b.currentConfidence - a.currentConfidence ||
            (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
        )
        .map((hypothesis) => [hypothesis.key, hypothesis.currentConfidence]);
      const res = await get(`${base}/hypotheses?${at(asOf)}`);
      expect(res.data.asOf).toBe(asOf);
      const served = (res.data.items as { key: string; currentConfidence: number }[]).map(
        (hypothesis) => [hypothesis.key, hypothesis.currentConfidence],
      );
      expect(served).toEqual(expected);
      // The series never extends past the window.
      for (const hypothesis of res.data.items as { timeline: { at: string }[] }[]) {
        for (const point of hypothesis.timeline) {
          expect(Date.parse(point.at)).toBeLessThanOrEqual(Date.parse(asOf));
        }
      }
    });
  }

  it('shows only the events of the window on the timeline and counts the rest', async () => {
    for (const suffix of AS_OF_SUFFIXES) {
      const asOf = eventBySuffix(events, suffix).timestamp;
      const res = await get(`${base}/timeline?${at(asOf)}&limit=200`);
      const visible = eventsUpTo(events, asOf);
      expect(res.data.asOf).toBe(asOf);
      expect(res.data.events.map((event: { id: string }) => event.id)).toEqual(
        visible.map((event) => event.id),
      );
      expect(res.data.total).toBe(visible.length);
      const later = eventsAfter(events, asOf).length;
      expect(res.data.withheldFutureEventCount).toBe(later);
      expect(res.data.withheldFutureEventCount).toBe(
        await h.repos(CONTOSO).cases.countEventsAfter(ONE, asOf),
      );
      for (const series of res.data.hypothesisSeries as { points: { at: string }[] }[]) {
        for (const point of series.points) {
          expect(Date.parse(point.at)).toBeLessThanOrEqual(Date.parse(asOf));
        }
      }
    }
  });

  it('builds the as-of twin from the same window and counts the withheld events', async () => {
    const asOf = eventBySuffix(events, 'e07').timestamp;
    const fresh = freshAnalysis(asOf);
    const expected = buildDigitalTwin({
      caseRecord,
      events: eventsUpTo(events, asOf),
      resolution: null,
      analysis: fresh,
      pack,
      ctx: refCtx,
      asOf,
    });
    const res = await get(`${base}/twin?${at(asOf)}`);
    expect(res.data.asOf).toBe(asOf);
    expect(res.data.fields.map((field: { id: string }) => field.id).sort()).toEqual(
      expected.fields.map((field) => field.id).sort(),
    );
    expect(res.data.withheldFutureEventCount).toBe(eventsAfter(events, asOf).length);
    for (const field of res.data.fields as { observedAt: string | null }[]) {
      if (field.observedAt !== null) {
        expect(Date.parse(field.observedAt)).toBeLessThanOrEqual(Date.parse(asOf));
      }
    }
  });

  it('serves decision-time actions: what the window had realised, no retrospective note', async () => {
    const asOf = eventBySuffix(events, 'e07').timestamp;
    const fresh = freshAnalysis(asOf);
    const res = await get(`${base}/actions?${at(asOf)}`);
    const served = res.data.items as {
      id: string;
      realizedInformationGainBits: number;
      lowValueReasons: string[];
      lowValue: boolean;
    }[];
    expect(served.map((action) => action.id)).toEqual(fresh.actions.map((action) => action.id));
    for (const action of served) {
      const expected = fresh.actions.find((candidate) => candidate.id === action.id);
      expect(action.realizedInformationGainBits).toBe(expected?.realizedInformationGainBits);
      expect(action.lowValue).toBe(expected?.lowValue);
      expect(action.lowValueReasons.join(' ')).not.toMatch(/retrospectively/i);
    }

    // An action whose answer arrives after the window has realised nothing by then, although the
    // whole record shows what its answer produced.
    const e05 = eventBySuffix(events, 'e05');
    const early = (await get(`${base}/actions?${at(e05.timestamp)}`)).data.items as {
      eventId: string;
      realizedInformationGainBits: number;
    }[];
    const whole = (await get(`${base}/actions`)).data.items as {
      eventId: string;
      realizedInformationGainBits: number;
    }[];
    const asOfBits = early.find((action) => action.eventId === e05.id)?.realizedInformationGainBits;
    const wholeBits = whole.find(
      (action) => action.eventId === e05.id,
    )?.realizedInformationGainBits;
    expect(asOfBits).toBeDefined();
    expect(wholeBits).toBeGreaterThan(asOfBits ?? Number.POSITIVE_INFINITY);
  });

  it('carries no hindsight information gain on the as-of graph action nodes', async () => {
    const asOf = eventBySuffix(events, 'e03').timestamp;
    const fresh = freshAnalysis(asOf);
    const res = await get(`${base}/graph?${at(asOf)}`);
    expect(res.data.asOf).toBe(asOf);
    const nodes = res.data.nodes as { id: string; kind: string; detail: string; status: string }[];
    const actionNodes = nodes.filter((node) => node.kind === 'action');
    expect(actionNodes.length).toBe(fresh.actions.length);
    for (const node of actionNodes) {
      const action = fresh.actions.find((candidate) => `action:${candidate.id}` === node.id);
      expect(action).toBeDefined();
      const bits = /(\d+(?:\.\d+)?) bits gained/.exec(node.detail);
      expect(bits).not.toBeNull();
      expect(Number(bits?.[1])).toBe(
        Math.round((action?.realizedInformationGainBits ?? 0) * 100) / 100,
      );
      // Colour comes from decision-time facts only.
      if (!action?.lowValue && !action?.isRepeat && !action?.destructive) {
        expect(node.status).toBe(
          (action?.relativeValueAtDecision ?? 0) >= 0.6 ? 'productive' : 'uncertain',
        );
      }
    }
    // Whole-record action nodes are retrospective and say how much the answers eventually produced.
    const whole = (await get(`${base}/graph`)).data.nodes as { kind: string; detail: string }[];
    const wholeBits = whole
      .filter((node) => node.kind === 'action')
      .map((node) => Number(/(\d+(?:\.\d+)?) bits gained/.exec(node.detail)?.[1] ?? 0));
    expect(Math.max(...wholeBits)).toBeGreaterThan(0);
  });

  it('lists the forks of the window with no hindsight view, whoever asks', async () => {
    for (const suffix of AS_OF_SUFFIXES) {
      const asOf = eventBySuffix(events, suffix).timestamp;
      const fresh = freshAnalysis(asOf);
      for (const persona of [PERSONAS.reviewer, PERSONAS.admin, PERSONAS.engineer]) {
        const res = await get(`${base}/forks?${at(asOf)}`, persona);
        const items = res.data.items as { id: string; retrospective: unknown; timestamp: string }[];
        expect(items.map((fork) => fork.id)).toEqual(fresh.forks.map((fork) => fork.id));
        expect(res.data.earliestMeaningfulForkId).toBe(fresh.earliestMeaningfulForkId);
        for (const fork of items) {
          expect(fork.retrospective).toBeNull();
          expect(Date.parse(fork.timestamp)).toBeLessThanOrEqual(Date.parse(asOf));
        }
      }
    }
  });

  it('scores quality on the window alone and labels it with the instant', async () => {
    for (const suffix of AS_OF_SUFFIXES) {
      const asOf = eventBySuffix(events, suffix).timestamp;
      const expected = computeQualityReview({
        analysis: freshAnalysis(asOf),
        pack,
        ctx: refCtx,
        config: DEFAULT_QUALITY_CONFIG,
        actionConfig: DEFAULT_ACTION_VALUE_CONFIG,
        asOf,
      });
      const res = await get(`${base}/quality?${at(asOf)}`);
      expect(res.data.asOf).toBe(asOf);
      expect(res.data.estimated).toBe(true);
      expect(res.data.compositeScore).toBe(expected.compositeScore);
      expect(res.data.band).toBe(expected.band);
      expect(res.data.dimensions.map((dimension: { score: number }) => dimension.score)).toEqual(
        expected.dimensions.map((dimension) => dimension.score),
      );
    }
  });

  it('replays the live warnings over the window alone', async () => {
    for (const suffix of AS_OF_SUFFIXES) {
      const asOf = eventBySuffix(events, suffix).timestamp;
      const expected = replayWarnings({
        events,
        resolution,
        pack,
        ctx: refCtx,
        config: DEFAULT_ACTION_VALUE_CONFIG,
        asOf,
      });
      const res = await get(`${base}/warnings?${at(asOf)}`);
      const served = (res.data.items as { fingerprint: string; state: string; rank: number }[]).map(
        (warning) => [warning.rank, warning.fingerprint, warning.state],
      );
      expect(served).toEqual(
        expected.warnings.map((warning) => [warning.rank, warning.fingerprint, warning.state]),
      );
      for (const warning of res.data.items as { raisedAt: string; resolvedAt: string | null }[]) {
        expect(Date.parse(warning.raisedAt)).toBeLessThanOrEqual(Date.parse(asOf));
        if (warning.resolvedAt !== null) {
          expect(Date.parse(warning.resolvedAt)).toBeLessThanOrEqual(Date.parse(asOf));
        }
      }
    }
  });

  it('estimates metrics on the window and says avoidable effort needs the whole path', async () => {
    const asOf = eventBySuffix(events, 'e07').timestamp;
    const res = await get(`${base}/metrics?${at(asOf)}`);
    expect(res.statusCode).toBe(200);
    const items = res.data.items as {
      key: string;
      estimated: boolean;
      comparison: unknown;
      ase: unknown;
    }[];
    expect(items.every((metric) => metric.estimated)).toBe(true);
    const ase = items.find((metric) => metric.key === 'avoidable_support_effort');
    expect(ase?.comparison ?? null).toBeNull();
  });

  it('holds exactly the claims, evidence, links and missing evidence of a fresh analysis', async () => {
    for (const suffix of AS_OF_SUFFIXES) {
      const asOf = eventBySuffix(events, suffix).timestamp;
      const fresh = freshAnalysis(asOf);
      const sorted = (ids: readonly string[]): string[] => [...ids].sort();

      let cursor: string | null = null;
      const claims: { id: string; supportingEvidenceIds: string[] }[] = [];
      do {
        const res = await get(
          `${base}/evidence?${at(asOf)}&limit=30${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
        );
        claims.push(...res.data.items);
        expect(res.data.missing.map((item: { id: string }) => item.id)).toEqual(
          fresh.missing.map((item) => item.id),
        );
        cursor = res.data.nextCursor;
      } while (cursor !== null);
      expect(sorted(claims.map((claim) => claim.id))).toEqual(
        sorted(fresh.claims.map((claim) => claim.id)),
      );
      // What each claim cites is what the window knew: the fresh analysis' own citations.
      for (const claim of claims) {
        const expected = fresh.claims.find((candidate) => candidate.id === claim.id);
        expect(claim.supportingEvidenceIds).toEqual(expected?.supportingEvidenceIds);
      }

      const arena = (await get(`${base}/hypotheses?${at(asOf)}`)).data;
      expect(sorted(arena.evidence.map((item: { id: string }) => item.id))).toEqual(
        sorted(fresh.evidence.map((item) => item.id)),
      );
      expect(sorted(arena.links.map((item: { id: string }) => item.id))).toEqual(
        sorted(fresh.links.map((item) => item.id)),
      );
      expect(arena.missing.map((item: { id: string }) => item.id)).toEqual(
        fresh.missing.map((item) => item.id),
      );
      // A requirement met after the window is still missing in it.
      for (const item of arena.missing as { resolvedAt: string | null }[]) {
        if (item.resolvedAt !== null) {
          expect(Date.parse(item.resolvedAt)).toBeLessThanOrEqual(Date.parse(asOf));
        }
      }
    }
  });

  it('derives the claims and evidence of one event from the window alone', async () => {
    const asOf = eventBySuffix(events, 'e07').timestamp;
    const fresh = freshAnalysis(asOf);
    for (const event of eventsUpTo(events, asOf)) {
      const res = await get(`${base}/events/${event.id}?${at(asOf)}`);
      expect(res.data.claims.map((claim: { id: string }) => claim.id).sort()).toEqual(
        fresh.claims
          .filter((claim) => claim.eventId === event.id)
          .map((claim) => claim.id)
          .sort(),
      );
      expect(res.data.evidence.map((item: { id: string }) => item.id).sort()).toEqual(
        fresh.evidence
          .filter((item) => item.eventId === event.id)
          .map((item) => item.id)
          .sort(),
      );
    }
  });

  it('ranks the next actions on the window alone, as a fresh analysis does', async () => {
    for (const suffix of AS_OF_SUFFIXES) {
      const asOf = eventBySuffix(events, suffix).timestamp;
      const view = createTemporalView(events, asOf, { resolution });
      const expected = toBreakdowns(
        pack,
        DEFAULT_ACTION_VALUE_CONFIG,
        analyzeView(view, pack, ONE).rankingState,
      );
      const res = await get(`${base}/action-values?${at(asOf)}`);
      expect(res.data.asOf).toBe(asOf);
      const served = (key: 'candidates' | 'blocked') =>
        (res.data[key] as { actionKey: string; rank: number; score: number }[]).map((entry) => [
          entry.actionKey,
          entry.rank,
          entry.score,
        ]);
      expect(served('candidates')).toEqual(
        expected.candidates.map((entry) => [entry.actionKey, entry.rank, entry.score]),
      );
      expect(served('blocked')).toEqual(
        expected.blocked.map((entry) => [entry.actionKey, entry.rank, entry.score]),
      );
      // The belief shown is the one the ranking was computed from, and it is exactly the last step of
      // the same window's timeline (one update path), so a reader never sees two different numbers.
      const belief = analyzeView(view, pack, ONE).belief;
      const posterior = res.data.posterior as { key: string; confidence: number }[];
      for (const entry of posterior) {
        expect(entry.confidence).toBe(round(belief[entry.key] ?? 0, 3));
      }
      const fresh = freshAnalysis(asOf);
      const last = fresh.timeline.steps[fresh.timeline.steps.length - 1];
      for (const entry of posterior) {
        expect(entry.confidence).toBe(round(last?.posterior[entry.key] ?? Number.NaN, 3));
      }
      const top = Object.entries(last?.posterior ?? {}).sort((a, b) => b[1] - a[1])[0];
      expect(posterior[0]?.key).toBe(top?.[0]);
    }
  });
});

describe('edge windows', () => {
  it('answers an instant before the first event with empty views, never an error', async () => {
    const asOf = '2026-03-09T09:00:00Z';
    expect(Date.parse(asOf)).toBeLessThan(Date.parse(events[0]?.timestamp ?? ''));
    for (const [name, url] of Object.entries(asOfUrls(asOf))) {
      const res = await get(url);
      expect(res.statusCode, `${name}: ${res.body.slice(0, 300)}`).toBe(200);
    }
    const timeline = (await get(`${base}/timeline?${at(asOf)}`)).data;
    expect(timeline.events).toEqual([]);
    expect(timeline.total).toBe(0);
    expect(timeline.withheldFutureEventCount).toBe(events.length);
    const probe = leakProbe(events, resolution, asOf, workload, {
      allowedInstants: [caseRecord.openedAt],
    });
    const leaks: Record<string, string[]> = {};
    for (const [name, url] of Object.entries(asOfUrls(asOf))) {
      const found = findLeaks((await get(url)).body, probe);
      if (found.length > 0) leaks[name] = found;
    }
    expect(leaks).toEqual({});
    const ledger = (await get(`${base}/evidence?${at(asOf)}`)).data;
    expect(ledger.items).toEqual([]);
    expect(Object.values(ledger.counts as Record<string, number>).every((n) => n === 0)).toBe(true);
    const quality = (await get(`${base}/quality?${at(asOf)}`)).data;
    expect(quality.uncertaintyNote).toMatch(/nothing can be assessed|not yet assessable/i);
    expect((await get(`${base}/forks?${at(asOf)}`)).data.items).toEqual([]);
    const ranking = (await get(`${base}/action-values?${at(asOf)}`)).data;
    expect(ranking.asOf).toBe(asOf);
    expect(ranking.candidates.length).toBeGreaterThan(0);
  });

  it('treats an instant after the whole record as the whole record', async () => {
    const asOf = '2027-01-01T00:00:00Z';
    const stored = {
      quality: (await get(`${base}/quality`)).data,
      forks: (await get(`${base}/forks`)).data,
      hypotheses: (await get(`${base}/hypotheses`)).data,
      timeline: (await get(`${base}/timeline?limit=200`)).data,
    };
    const late = {
      quality: (await get(`${base}/quality?${at(asOf)}`)).data,
      forks: (await get(`${base}/forks?${at(asOf)}`)).data,
      hypotheses: (await get(`${base}/hypotheses?${at(asOf)}`)).data,
      timeline: (await get(`${base}/timeline?${at(asOf)}&limit=200`)).data,
    };
    expect(late.quality.compositeScore).toBe(stored.quality.compositeScore);
    expect(late.forks.items.map((fork: { id: string }) => fork.id)).toEqual(
      stored.forks.items.map((fork: { id: string }) => fork.id),
    );
    expect(late.forks.earliestMeaningfulForkId).toBe(stored.forks.earliestMeaningfulForkId);
    expect(
      late.hypotheses.items.map((item: { key: string; currentConfidence: number }) => [
        item.key,
        item.currentConfidence,
      ]),
    ).toEqual(
      stored.hypotheses.items.map((item: { key: string; currentConfidence: number }) => [
        item.key,
        item.currentConfidence,
      ]),
    );
    expect(late.timeline.total).toBe(stored.timeline.total);
    expect(late.timeline.withheldFutureEventCount).toBe(0);
  });

  it('gives the same view for an instant spelled with or without milliseconds', async () => {
    const plain = eventBySuffix(events, 'e07').timestamp;
    const precise = plain.replace('Z', '.000Z');
    const a = (await get(`${base}/timeline?${at(plain)}&limit=200`)).data;
    const b = (await get(`${base}/timeline?${at(precise)}&limit=200`)).data;
    expect(b.events.map((event: { id: string }) => event.id)).toEqual(
      a.events.map((event: { id: string }) => event.id),
    );
    expect(b.asOf).toBe(precise);
  });

  it('serves an instant between two events as the earlier one', async () => {
    const e03 = eventBySuffix(events, 'e03');
    const between = new Date(Date.parse(e03.timestamp) + 60 * 60_000).toISOString();
    const res = await get(`${base}/timeline?${at(between)}&limit=200`);
    const ids = res.data.events.map((event: { id: string }) => event.id);
    expect(ids).toEqual(eventsUpTo(events, between).map((event) => event.id));
    expect(ids).toContain(e03.id);
    expect(ids).not.toContain(eventBySuffix(events, 'e04').id);
  });

  it('answers 404 for an event recorded after the window, as if it did not exist', async () => {
    const e03 = eventBySuffix(events, 'e03');
    const e04 = eventBySuffix(events, 'e04');
    const asOf = e03.timestamp;
    const later = await get(`${base}/events/${e04.id}?${at(asOf)}`);
    expect(later.statusCode).toBe(404);
    expect(later.body).not.toContain(e04.timestamp);
    const detail = await get(`${base}/events/${e03.id}?${at(asOf)}`);
    expect(detail.statusCode).toBe(200);
    // e04 answers e03, but it was not recorded yet.
    expect(detail.data.responses).toEqual([]);
    const whole = await get(`${base}/events/${e03.id}`);
    expect(whole.data.responses.map((reply: { id: string }) => reply.id)).toContain(e04.id);
  });
});

describe('counterfactual overlays inside a window', () => {
  it('withholds a scenario until its decision instant has been reached and never shows the real path', async () => {
    const scenarios = await h.repos(CONTOSO).counterfactuals.list(ONE);
    const scenario = scenarios[0];
    expect(scenario).toBeDefined();
    if (scenario === undefined) return;
    const boundary = scenario.boundary.asOf;

    // Before the decision instant: no overlay.
    const before = new Date(Date.parse(boundary) - 60_000).toISOString();
    const early = await get(`${base}/graph?${at(before)}&scenarioId=${scenario.id}`);
    expect(early.statusCode).toBe(200);
    expect(early.data.scenarioId).toBeNull();
    expect((early.data.nodes as { simulated: boolean }[]).some((node) => node.simulated)).toBe(
      false,
    );
    const earlyTimeline = await get(`${base}/timeline?${at(before)}&scenarioId=${scenario.id}`);
    expect(earlyTimeline.data.simulatedEvents).toEqual([]);

    // At the decision instant: simulated nodes, every one labelled, and a summary that does not
    // compare the simulated path with the real one (that comparison is hindsight).
    const res = await get(`${base}/graph?${at(boundary)}&scenarioId=${scenario.id}`);
    expect(res.data.scenarioId).toBe(scenario.id);
    const simulated = (
      res.data.nodes as { simulated: boolean; kind: string; detail: string }[]
    ).filter((node) => node.simulated);
    expect(simulated.length).toBeGreaterThan(0);
    const outcome = simulated.find((node) => node.kind === 'outcome');
    expect(outcome?.detail).not.toMatch(/real case|versus/i);
    expect(outcome?.detail).toMatch(/Simulated estimate, not a measurement/);
    // The engine writes the summary from the decision instant and the simulated path alone, so the
    // stored text is what the window shows (the comparison with the real path is the hindsight check).
    expect(scenario.summary).not.toMatch(/real case|versus/i);
    expect(outcome?.detail).toBe(scenario.summary);
    const timeline = await get(`${base}/timeline?${at(boundary)}&scenarioId=${scenario.id}`);
    expect(timeline.data.simulatedEvents.length).toBe(scenario.steps.length);
    expect(
      (timeline.data.simulatedEvents as { simulated: boolean }[]).every((step) => step.simulated),
    ).toBe(true);
  });
});

describe('recomputation is cached and metered', () => {
  // A harness of its own on the shared database: its caches and budget start empty and full, so the
  // counts below are exact whatever the tests above have already computed.
  let g: Harness;
  beforeAll(async () => {
    g = await createHarness({ database });
  }, TEST_DATABASE_STARTUP_TIMEOUT_MS);
  afterAll(async () => {
    await g.close();
  });

  const caller = (userId: string, tenantId: string = CONTOSO) => ({
    auth: { tenantId, userId },
    now: () => g.clock.now(),
  });
  const deps = () => viewDepsFor(g.infra);
  const budget = () => engineBudgetFor(g.infra);
  const cold = (): number => deps().cache.passes.stats.coldPasses;
  const ask = (path: string, persona: string = PERSONAS.reviewer) =>
    g.call(persona, { method: 'GET', url: `/api/v1/cases/${ONE}${path}` });
  const hypotheses = (asOf: string, persona: string = PERSONAS.reviewer) =>
    ask(`/hypotheses?${at(asOf)}`, persona);

  it('[NFR-SEC-05] runs one engine pass for every spelling and offset inside one window', async () => {
    const first = eventBySuffix(events, 'e20').timestamp;
    const next = eventBySuffix(events, 'e21').timestamp;
    const gap = Date.parse(next) - Date.parse(first);
    expect(gap).toBeGreaterThan(4);
    const variants = [
      first,
      first.replace('Z', '.000Z'),
      first.replace('Z', '.0000Z'),
      first.replace('Z', '.00000Z'),
      new Date(Date.parse(first) + 1).toISOString(),
      new Date(Date.parse(first) + 2).toISOString(),
      new Date(Date.parse(first) + Math.floor(gap / 2)).toISOString(),
      new Date(Date.parse(next) - 1).toISOString(),
    ];
    const before = cold();
    const bodies: string[] = [];
    for (const asOf of variants) {
      const res = await hypotheses(asOf);
      expect(res.statusCode, asOf).toBe(200);
      expect(res.data.asOf).toBe(asOf);
      bodies.push(JSON.stringify({ ...res.data, asOf: null }));
    }
    expect(cold() - before).toBe(1);
    // The answers are the same view of the same window.
    expect(new Set(bodies).size).toBe(1);
    // The next event opens another window, which needs its own pass.
    expect((await hypotheses(next)).statusCode).toBe(200);
    expect(cold() - before).toBe(2);
    expect((await hypotheses(next.replace('Z', '.000Z'))).statusCode).toBe(200);
    expect(cold() - before).toBe(2);
  });

  it('[NFR-SEC-05] keeps every route of one instant on one pass, and echoes each spelling', async () => {
    const instant = eventBySuffix(events, 'e12').timestamp;
    const precise = instant.replace('Z', '.000Z');
    const before = cold();
    for (const [name, url] of Object.entries(asOfUrls(instant))) {
      expect((await g.call(PERSONAS.reviewer, { method: 'GET', url })).statusCode, name).toBe(200);
    }
    expect(cold() - before).toBe(1);
    const plain = (await ask(`/quality?${at(instant)}`)).data;
    const spelled = (await ask(`/quality?${at(precise)}`)).data;
    expect(plain.asOf).toBe(instant);
    expect(spelled.asOf).toBe(precise);
    expect({ ...spelled, asOf: null }).toEqual({ ...plain, asOf: null });
    expect(cold() - before).toBe(1);
  });

  it('[NFR-SEC-05] answers 429 with Retry-After when a caller keeps asking for new windows, and only then', async () => {
    const asker = PERSONAS.reviewer;
    g.clock.advance(ENGINE_BUDGET_WINDOW_MS);
    expect(budget().passes).toBe(30);
    expect(budget().windowMs).toBe(60_000);
    expect(budget().remaining(caller(asker))).toBe(30);

    // One cold request takes one unit; a request for a cached window takes none.
    const warm = eventBySuffix(events, 'e20').timestamp;
    const fresh = eventBySuffix(events, 'e22').timestamp;
    const spent = cold();
    expect((await hypotheses(fresh)).statusCode).toBe(200);
    expect(cold() - spent).toBe(1);
    expect(budget().remaining(caller(asker))).toBe(29);
    expect((await hypotheses(fresh)).statusCode).toBe(200);
    expect((await hypotheses(fresh.replace('Z', '.000Z'))).statusCode).toBe(200);
    expect(budget().remaining(caller(asker))).toBe(29);

    // Run the allowance down, as a client scanning many new instants would.
    budget().charge(caller(asker), 29);
    expect(budget().remaining(caller(asker))).toBe(0);

    const next = eventBySuffix(events, 'e24').timestamp;
    const refused = await hypotheses(next);
    expect(refused.statusCode).toBe(429);
    expect(refused.data.code).toBe('rate_limited');
    expect(refused.headers['retry-after']).toBe('2');
    expect(refused.headers['content-type']).toContain('application/problem+json');
    expect(refused.body).not.toContain(asker);
    expect(cold() - spent).toBe(1);

    // Everything already computed is still served: other routes of an instant its first request paid
    // for, other spellings, and the stored views. What would need new work is refused: a new window,
    // and a new instant of a cached window that needs more than the shared pass (its own quality or
    // warning replay), while one that needs only the pass is free.
    expect((await hypotheses(warm)).statusCode).toBe(200);
    expect((await ask(`/quality?${at(fresh)}`)).statusCode).toBe(200);
    expect((await ask(`/twin?${at(fresh)}`)).statusCode).toBe(200);
    expect((await ask(`/warnings?${at(fresh)}`)).statusCode).toBe(200);
    expect((await ask('/hypotheses')).statusCode).toBe(200);
    const nearby = new Date(Date.parse(fresh) + 5).toISOString();
    expect((await hypotheses(nearby)).statusCode).toBe(200);
    expect((await ask(`/quality?${at(nearby)}`)).statusCode).toBe(429);
    expect((await ask(`/warnings?${at(nearby)}`)).statusCode).toBe(429);
    expect((await ask(`/graph?${at(next)}`)).statusCode).toBe(429);
    expect(cold() - spent).toBe(1);

    // Another user of the same tenant has an allowance of their own.
    expect((await hypotheses(next, PERSONAS.engineer)).statusCode).toBe(200);
    expect(budget().remaining(caller(PERSONAS.engineer))).toBe(29);
    // And the first user can use that window now that it is cached.
    expect((await hypotheses(next)).statusCode).toBe(200);

    // After the window the caller can start new passes again.
    g.clock.advance(ENGINE_BUDGET_WINDOW_MS);
    expect(budget().remaining(caller(asker))).toBe(30);
    expect((await hypotheses(eventBySuffix(events, 'e26').timestamp)).statusCode).toBe(200);
    expect(budget().remaining(caller(asker))).toBe(29);
  });

  it('[NFR-SEC-05] draws on one bucket per tenant and user, never on a case', async () => {
    g.clock.advance(ENGINE_BUDGET_WINDOW_MS);
    const first = (await h.repos(CONTOSO).cases.getAllEvents(TWO))[6]?.timestamp ?? '';
    const before = cold();
    const res = await g.call(PERSONAS.reviewer, {
      method: 'GET',
      url: `/api/v1/cases/${TWO}/hypotheses?${at(first)}`,
    });
    expect(res.statusCode).toBe(200);
    const spent = cold() - before;
    expect(spent).toBeLessThanOrEqual(1);
    // Case Two is another case of the same tenant: it shares the reviewer's bucket.
    expect(budget().remaining(caller(PERSONAS.reviewer))).toBe(30 - spent);
    // Another user, and another tenant's user, have buckets of their own.
    expect(budget().remaining(caller(PERSONAS.engineer))).toBe(30);
    expect(budget().remaining(caller(PERSONAS.otherTenantEngineer, FABRIKAM))).toBe(30);
  });

  it('[FR-TL-06] recomputes the whole record under the stored run, with exactly the stored artefact ids', async () => {
    const ctx = contextFor(h, PERSONAS.reviewer);
    const state = await loadViewState(ctx, ONE);
    if (state.run === null) throw new Error('expected an analysed case');
    const analysis = await new ViewCache()
      .computation(ctx, state.inputs, state.run, null)
      .analysis();
    const repos = h.repos(CONTOSO);
    const sorted = (ids: readonly string[]): string[] => [...ids].sort();
    expect(sorted(analysis.forks.map((fork) => fork.id))).toEqual(
      sorted((await repos.analysis.listForks(ONE)).map((fork) => fork.id)),
    );
    expect(sorted(analysis.actions.map((action) => action.id))).toEqual(
      sorted((await repos.analysis.listActions(ONE)).map((action) => action.id)),
    );
    expect(sorted(analysis.evidence.map((item) => item.id))).toEqual(
      sorted((await repos.analysis.listEvidence(ONE)).map((item) => item.id)),
    );
    expect(sorted(analysis.hypotheses.map((item) => item.id))).toEqual(
      sorted((await repos.analysis.listHypotheses(ONE)).map((item) => item.id)),
    );
    const storedClaims = await repos.analysis.listClaims(ONE, { limit: 200 });
    expect(sorted(analysis.claims.map((claim) => claim.id))).toEqual(
      sorted(storedClaims.items.map((claim) => claim.id)),
    );
    expect(analysis.hypotheses.every((item) => item.analysisRunId === state.run?.id)).toBe(true);
  });
});
