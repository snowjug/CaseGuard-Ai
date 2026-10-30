import { beforeAll, describe, expect, it } from 'vitest';
import {
  createFullView,
  getCompiledPack,
  replayWarnings,
  runDeterministicAnalysis,
  type DeterministicAnalysis,
  type EngineContext,
} from '@caseguard/domain';
import {
  DEFAULT_ACTION_VALUE_CONFIG,
  type CaseWarning,
  type EvidenceCategory,
} from '@caseguard/schemas';
import { ValidationFailedError } from '../src/errors';
import { parseCaseIds } from '../src/services/views/compare';
import { hypothesisAliases, rankHypotheses } from '../src/services/views/hypotheses';
import {
  canonicalInstant,
  compareInstants,
  compareText,
  knownBy,
} from '../src/services/views/instants';
import { LruCache } from '../src/services/views/lru';
import {
  decisionTimeAction,
  overlayClaim,
  overlayClaims,
  overlayFork,
  overlayWarning,
  withoutHindsight,
} from '../src/services/views/overlay';
import { pageAfter, unique } from '../src/services/views/paging';
import { requireReason } from '../src/services/views/reviews';
import { decisionTimeSummary, scenarioForWindow } from '../src/services/views/scenarios';
import { eventsRelatedTo } from '../src/services/views/timeline';
import {
  applyTimelineFilters,
  parseCsvFilter,
  parseTimelineFilters,
  type FilterableEvent,
} from '../src/services/views/timeline-filters';
import { dismissalsOf } from '../src/services/views/warnings';
import { SAMPLE_FILES, normalizeSample } from './support/samples';

const CASE_ID = 'case_views_units';
const ctx: EngineContext = {
  tenantId: 'tenant_contoso_support',
  caseId: CASE_ID,
  runId: 'run_units',
  now: '2026-10-29T00:00:00.000Z',
  createdBy: 'system:test',
  seed: 'units',
};

let analysis: DeterministicAnalysis;
let warnings: CaseWarning[];

beforeAll(() => {
  const normalized = normalizeSample(SAMPLE_FILES.caseOne, {
    tenantId: ctx.tenantId,
    caseId: CASE_ID,
  });
  const pack = getCompiledPack(normalized.case.workload);
  if (pack === null) throw new Error('The sample workload has no knowledge pack');
  analysis = runDeterministicAnalysis({
    view: createFullView(normalized.events, normalized.resolution),
    pack,
    config: DEFAULT_ACTION_VALUE_CONFIG,
    ctx,
  });
  warnings = replayWarnings({
    events: normalized.events,
    resolution: normalized.resolution,
    pack,
    ctx,
    config: DEFAULT_ACTION_VALUE_CONFIG,
    analysis,
  }).warnings;
}, 60_000);

describe('LruCache', () => {
  it('evicts the least recently used entry and counts a read as a use', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
  });

  it('refreshes an entry that is set again and never exceeds its capacity', () => {
    const cache = new LruCache<number, string>(3);
    for (let i = 0; i < 20; i++) cache.set(i, `v${i}`);
    expect(cache.size).toBe(3);
    cache.set(17, 'again');
    cache.set(99, 'new');
    expect(cache.get(17)).toBe('again');
    expect(cache.get(18)).toBeUndefined();
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('refuses a capacity below one', () => {
    expect(() => new LruCache(0)).toThrow(RangeError);
    expect(() => new LruCache(1.5)).toThrow(RangeError);
  });
});

describe('instants', () => {
  it('[FR-TL-06] compares instants, not strings', () => {
    // The same instant sorts differently as a string, which is why string order is never used.
    expect('2026-03-09T09:41:00Z' > '2026-03-09T09:41:00.000Z').toBe(true);
    expect(compareInstants('2026-03-09T09:41:00Z', '2026-03-09T09:41:00.000Z')).toBe(0);
    const known = knownBy('2026-03-09T09:41:00.500Z');
    expect(known('2026-03-09T09:41:00Z')).toBe(true);
    expect(known('2026-03-09T09:41:00.500Z')).toBe(true);
    expect(known('2026-03-09T09:41:00.501Z')).toBe(false);
    expect(knownBy(null)('2999-01-01T00:00:00Z')).toBe(true);
    expect(canonicalInstant('2026-03-09T09:41:00Z')).toBe('2026-03-09T09:41:00.000Z');
    expect(compareText('a', 'b')).toBe(-1);
    expect(compareText('b', 'a')).toBe(1);
    expect(compareText('a', 'a')).toBe(0);
  });
});

describe('keyset paging of an ordered list', () => {
  const items = ['a', 'b', 'c', 'd', 'e'];
  const options = (limit: number, after: string | null) => ({
    limit,
    hasCursor: after !== null,
    isAfterCursor: (item: string) => after === null || item > after,
    cursorOf: (item: string) => item,
  });

  it('returns pages that join without gaps or repeats', () => {
    const first = pageAfter(items, options(2, null));
    expect(first).toEqual({ items: ['a', 'b'], nextCursor: 'b' });
    const second = pageAfter(items, options(2, first.nextCursor));
    expect(second).toEqual({ items: ['c', 'd'], nextCursor: 'd' });
    const third = pageAfter(items, options(2, second.nextCursor));
    expect(third).toEqual({ items: ['e'], nextCursor: null });
  });

  it('gives no next cursor when the list ends exactly on a page, or when it is empty', () => {
    expect(pageAfter(items, options(5, null))).toEqual({ items, nextCursor: null });
    expect(pageAfter([], options(3, null))).toEqual({ items: [], nextCursor: null });
    expect(pageAfter(items, options(2, 'e'))).toEqual({ items: [], nextCursor: null });
    expect(unique([1, 2, 1, 3, 2])).toEqual([1, 2, 3]);
  });
});

describe('request validation helpers', () => {
  it('[NFR-SEC-05] requires a real reason and returns it trimmed', () => {
    expect(requireReason('  Checked the source  ')).toBe('Checked the source');
    expect(() => requireReason('    ')).toThrow(ValidationFailedError);
    expect(() => requireReason(' abc ')).toThrow(ValidationFailedError);
  });

  it('[NFR-SEC-05] accepts exactly two different, well-formed case ids', () => {
    expect(parseCaseIds('case_a, case_b')).toEqual(['case_a', 'case_b']);
    for (const bad of ['case_a', 'a,b,c', 'a,a', 'a,', ',', 'a,bad id', '']) {
      expect(() => parseCaseIds(bad), bad).toThrow(ValidationFailedError);
    }
  });

  it('[NFR-SEC-05] parses comma-separated filters and names the allowed values on a mistake', () => {
    const allowed = ['x', 'y', 'z'] as const;
    expect(parseCsvFilter(undefined, allowed, 'types')).toBeNull();
    expect(parseCsvFilter(' , ', allowed, 'types')).toBeNull();
    expect([...(parseCsvFilter('x, y,x', allowed, 'types') ?? [])]).toEqual(['x', 'y']);
    let caught: unknown;
    try {
      parseCsvFilter('x,w', allowed, 'types');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationFailedError);
    expect(caught instanceof ValidationFailedError ? caught.issues[0]?.message : '').toContain(
      'x, y, z',
    );
  });

  it('[FR-TL-02] clamps a zoom window to asOf and refuses a reversed one', () => {
    const asOf = '2026-03-09T12:00:00Z';
    const clamped = parseTimelineFilters({ to: '2026-03-09T18:00:00Z' }, asOf);
    expect(clamped.toMs).toBe(Date.parse(asOf));
    expect(parseTimelineFilters({ to: '2026-03-09T10:00:00Z' }, asOf).toMs).toBe(
      Date.parse('2026-03-09T10:00:00Z'),
    );
    expect(parseTimelineFilters({}, asOf).toMs).toBe(Date.parse(asOf));
    expect(parseTimelineFilters({}, null).toMs).toBeNull();
    expect(() =>
      parseTimelineFilters({ from: '2026-03-09T12:00:00Z', to: '2026-03-09T09:00:00Z' }, null),
    ).toThrow(ValidationFailedError);
  });

  it('[FR-TL-01] applies every timeline filter together', () => {
    const events: FilterableEvent[] = [
      {
        id: 'a',
        timestamp: '2026-03-09T09:00:00Z',
        type: 'customer_email',
        participantRole: 'customer_admin',
        categories: ['customer_reported'],
      },
      {
        id: 'b',
        timestamp: '2026-03-09T10:00:00Z',
        type: 'engineer_email',
        participantRole: 'support_engineer',
        categories: ['engineer_assumption'],
      },
      {
        id: 'c',
        timestamp: '2026-03-09T11:00:00Z',
        type: 'engineer_action',
        participantRole: 'support_engineer',
        categories: [],
      },
    ];
    type Query = Parameters<typeof parseTimelineFilters>[0];
    const ids = (query: Query, related: Set<string> | null = null): string[] =>
      applyTimelineFilters(events, parseTimelineFilters(query, null), related).map(
        (event) => event.id,
      );
    expect(ids({})).toEqual(['a', 'b', 'c']);
    expect(ids({ types: 'engineer_email,engineer_action' })).toEqual(['b', 'c']);
    expect(ids({ roles: 'customer_admin' })).toEqual(['a']);
    expect(ids({ category: 'engineer_assumption' })).toEqual(['b']);
    expect(ids({ from: '2026-03-09T10:00:00Z', to: '2026-03-09T10:00:00Z' })).toEqual(['b']);
    expect(ids({ roles: 'support_engineer' }, new Set(['c']))).toEqual(['c']);
    expect(ids({}, new Set())).toEqual([]);
  });
});

describe('decisions laid over a recomputed view', () => {
  it('[FR-EV-03] applies a reviewer correction and the stored version, keeping the machine value', () => {
    const [recomputed] = analysis.claims;
    if (recomputed === undefined) throw new Error('the sample has claims');
    const other: EvidenceCategory =
      recomputed.aiCategory === 'confirmed_fact' ? 'customer_reported' : 'confirmed_fact';
    const stored = {
      ...recomputed,
      category: other,
      reviewedCategory: other,
      reviewState: 'corrected' as const,
      reviewReason: 'Checked against the source',
      reviewedBy: 'user_riley_reviewer',
      reviewedAt: '2026-10-29T10:00:00.000Z',
      createdAt: '2026-10-01T00:00:00.000Z',
      createdBy: 'system:earlier',
      updatedAt: '2026-10-29T10:00:00.000Z',
      version: 4,
    };
    const merged = overlayClaim(recomputed, stored);
    expect(merged).toMatchObject({
      category: other,
      reviewedCategory: other,
      aiCategory: recomputed.aiCategory,
      reviewState: 'corrected',
      reviewReason: 'Checked against the source',
      reviewedBy: 'user_riley_reviewer',
      version: 4,
      createdBy: 'system:earlier',
    });
    expect(merged.text).toBe(recomputed.text);
    expect(merged.supportingEvidenceIds).toEqual(recomputed.supportingEvidenceIds);
  });

  it('[FR-EV-03] leaves an unreviewed claim as the engine classified it, with the stored version', () => {
    const [recomputed] = analysis.claims;
    if (recomputed === undefined) throw new Error('the sample has claims');
    const stored = { ...recomputed, category: 'ai_inference' as const, version: 3 };
    const merged = overlayClaim(recomputed, stored);
    expect(merged.category).toBe(recomputed.category);
    expect(merged.reviewState).toBe('pending');
    expect(merged.version).toBe(3);
    expect(overlayClaim(recomputed, undefined)).toBe(recomputed);
    const map = new Map([[recomputed.id, stored]]);
    expect(overlayClaims(analysis.claims, map)[0]?.version).toBe(3);
    expect(overlayClaims(analysis.claims, map)[1]).toBe(analysis.claims[1]);
  });

  it('[FR-CF-07] carries a fork review over and withholds the hindsight view', () => {
    const fork = analysis.forks.find((candidate) => candidate.retrospective !== null);
    if (fork === undefined) throw new Error('the sample has a fork with a hindsight view');
    const stored = {
      ...fork,
      reviewState: 'rejected' as const,
      reviewReason: 'Not a fork',
      version: 7,
    };
    const merged = overlayFork(fork, stored);
    expect(merged).toMatchObject({
      reviewState: 'rejected',
      reviewReason: 'Not a fork',
      version: 7,
    });
    expect(overlayFork(fork, { ...stored, reviewState: 'pending' }).reviewState).toBe('pending');
    expect(overlayFork(fork, undefined)).toBe(fork);

    const stripped = withoutHindsight(fork);
    expect(stripped.retrospective).toBeNull();
    expect({ ...stripped, retrospective: fork.retrospective }).toEqual(fork);
    const already = { ...fork, retrospective: null };
    expect(withoutHindsight(already)).toBe(already);
  });

  it('[FR-LQ-01] carries the stored version over a replayed warning, not its lifecycle', () => {
    const [replayed] = warnings;
    if (replayed === undefined) throw new Error('the sample has warnings');
    const stored = {
      ...replayed,
      state: 'dismissed' as const,
      version: 5,
      createdBy: 'system:earlier',
    };
    const merged = overlayWarning(replayed, stored);
    expect(merged.state).toBe(replayed.state);
    expect(merged.version).toBe(5);
    expect(merged.createdBy).toBe('system:earlier');
    expect(overlayWarning(replayed, undefined)).toBe(replayed);
  });

  it('[FR-LQ-01] keeps a later resolution or dismissal out of an as-of warning, taking only the version', () => {
    const [replayed] = warnings;
    if (replayed === undefined) throw new Error('the sample has warnings');
    const stored = {
      ...replayed,
      state: 'dismissed' as const,
      updatedAt: '2026-10-30T09:00:00.000Z',
      version: 5,
    };
    const merged = overlayWarning(replayed, stored);
    expect(merged.updatedAt).toBe(replayed.updatedAt);
    expect(merged.version).toBe(5);
  });

  it('[FR-EV-03] shows a review inside a window only once it was made, taking only the version before', () => {
    const [recomputed] = analysis.claims;
    if (recomputed === undefined) throw new Error('the sample has claims');
    const other: EvidenceCategory =
      recomputed.aiCategory === 'confirmed_fact' ? 'customer_reported' : 'confirmed_fact';
    const stored = {
      ...recomputed,
      category: other,
      reviewedCategory: other,
      reviewState: 'corrected' as const,
      reviewReason: 'Later logs showed this was a confirmed fact',
      reviewedBy: 'user_riley_reviewer',
      reviewedAt: '2026-10-30T09:00:00.000Z',
      updatedAt: '2026-10-30T09:00:00.000Z',
      version: 4,
    };
    const before = '2026-03-09T10:00:00Z';
    const hidden = overlayClaim(recomputed, stored, before);
    // Label, state, note, who and when are all later than the window, so none of them is in it.
    expect(hidden).toMatchObject({
      category: recomputed.category,
      reviewedCategory: recomputed.reviewedCategory,
      reviewState: recomputed.reviewState,
      reviewReason: recomputed.reviewReason,
      reviewedBy: recomputed.reviewedBy,
      reviewedAt: recomputed.reviewedAt,
      updatedAt: recomputed.updatedAt,
      aiCategory: recomputed.aiCategory,
      // The optimistic lock of a review started from this window still needs the version.
      version: 4,
    });
    expect(JSON.stringify(hidden)).not.toContain('Later logs');
    expect(JSON.stringify(hidden)).not.toContain('user_riley_reviewer');
    expect(JSON.stringify(hidden)).not.toContain('2026-10-30');

    // From the instant of the review (inclusive) it is part of the view; the whole record has it too.
    expect(overlayClaim(recomputed, stored, stored.reviewedAt)).toMatchObject({
      category: other,
      reviewState: 'corrected',
      reviewReason: stored.reviewReason,
      reviewedBy: 'user_riley_reviewer',
    });
    expect(overlayClaim(recomputed, stored, '2026-10-30T09:00:00.000Z').reviewState).toBe(
      'corrected',
    );
    expect(overlayClaim(recomputed, stored, '2026-10-30T08:59:59.999Z').reviewState).toBe(
      recomputed.reviewState,
    );
    expect(overlayClaim(recomputed, stored)).toMatchObject({
      reviewState: 'corrected',
      updatedAt: stored.updatedAt,
    });
    const map = new Map([[recomputed.id, stored]]);
    expect(overlayClaims(analysis.claims, map, before)[0]?.reviewState).toBe(
      recomputed.reviewState,
    );
    expect(overlayClaims(analysis.claims, map)[0]?.reviewState).toBe('corrected');
  });

  it('[FR-CF-07] shows a fork review inside a window only if the fork was not updated after it', () => {
    const fork = analysis.forks[0];
    if (fork === undefined) throw new Error('the sample has forks');
    const stored = {
      ...fork,
      reviewState: 'rejected' as const,
      reviewReason: 'Looking back, not a fork',
      updatedAt: '2026-10-30T09:00:00.000Z',
      version: 7,
    };
    const hidden = overlayFork(fork, stored, '2026-03-09T10:00:00Z');
    expect(hidden.reviewState).toBe(fork.reviewState);
    expect(hidden.reviewReason).toBe(fork.reviewReason);
    expect(hidden.updatedAt).toBe(fork.updatedAt);
    expect(hidden.version).toBe(7);
    expect(overlayFork(fork, stored, '2026-10-30T09:00:00.000Z')).toMatchObject({
      reviewState: 'rejected',
      reviewReason: 'Looking back, not a fork',
    });
    expect(overlayFork(fork, stored).reviewState).toBe('rejected');
  });

  it('[FR-LQ-02] hands the replay the dismissals people made, keyed by fingerprint', () => {
    const [warning] = warnings;
    if (warning === undefined) throw new Error('the sample has warnings');
    const dismissal = {
      by: 'user_ava_engineer',
      at: '2026-10-29T10:00:00.000Z',
      reason: 'Not relevant',
    };
    const dismissed = { ...warning, state: 'dismissed' as const, dismissal };
    expect(dismissalsOf([warning, dismissed])).toEqual([
      { dedupeKey: warning.fingerprint, ...dismissal },
    ]);
    expect(dismissalsOf([warning])).toEqual([]);
  });

  it('[FR-TL-06] withholds only the retrospective note from a decision-time action', () => {
    const action = analysis.actions.find((candidate) =>
      candidate.lowValueReasons.some((reason) => /^Retrospectively/i.test(reason)),
    );
    if (action === undefined) throw new Error('the sample has a retrospectively low-value action');
    const projected = decisionTimeAction(action);
    expect(projected.lowValueReasons.some((reason) => /retrospectively/i.test(reason))).toBe(false);
    expect(projected.lowValueReasons.length).toBe(action.lowValueReasons.length - 1);
    expect(projected.lowValue).toBe(action.lowValue);
    expect(projected.isRepeat).toBe(action.isRepeat);
    const untouched = analysis.actions.find((candidate) => candidate.lowValueReasons.length === 0);
    expect(untouched === undefined ? [] : decisionTimeAction(untouched).lowValueReasons).toEqual(
      [],
    );
  });
});

describe('hypotheses', () => {
  it('[FR-HY-01] ranks by confidence, breaking ties by key, without touching the input', () => {
    const items = [...analysis.hypotheses];
    const ranked = rankHypotheses(items);
    expect(items.map((item) => item.key)).toEqual(analysis.hypotheses.map((item) => item.key));
    const confidences = ranked.map((item) => item.currentConfidence);
    expect([...confidences].sort((a, b) => b - a)).toEqual(confidences);
    const [first] = items;
    if (first === undefined) throw new Error('the sample has hypotheses');
    const tied = rankHypotheses([
      { ...first, key: 'hyp.b', currentConfidence: 0.2 },
      { ...first, key: 'hyp.a', currentConfidence: 0.2 },
      { ...first, key: 'hyp.c', currentConfidence: 0.5 },
    ]);
    expect(tied.map((item) => item.key)).toEqual(['hyp.c', 'hyp.a', 'hyp.b']);
  });

  it('[FR-HY-01] knows a hypothesis by its record id and by its key', () => {
    const dns = analysis.hypotheses.find((item) => item.key === 'hyp.dns-resolution');
    if (dns === undefined) throw new Error('the sample has the DNS hypothesis');
    expect([...hypothesisAliases(analysis.hypotheses, dns.id)].sort()).toEqual(
      [dns.id, dns.key].sort(),
    );
    expect([...hypothesisAliases(analysis.hypotheses, dns.key)].sort()).toEqual(
      [dns.id, dns.key].sort(),
    );
    expect([...hypothesisAliases(analysis.hypotheses, 'hyp_unknown')]).toEqual(['hyp_unknown']);
  });

  it('[FR-TL-01] finds the events that bear on a hypothesis by either of its names', () => {
    const dns = analysis.hypotheses.find((item) => item.key === 'hyp.dns-resolution');
    if (dns === undefined) throw new Error('the sample has the DNS hypothesis');
    const byId = eventsRelatedTo(dns.id, analysis);
    const byKey = eventsRelatedTo(dns.key, analysis);
    expect(byId.size).toBeGreaterThan(0);
    expect([...byId].sort()).toEqual([...byKey].sort());
    expect(byId.size).toBeLessThan(analysis.view.events.length);
    expect(eventsRelatedTo('hyp_unknown', analysis).size).toBe(0);
  });
});

describe('counterfactual overlays inside a window', () => {
  const scenario = {
    label: 'Balanced path',
    boundary: { asOf: '2026-03-09T09:41:00Z' },
    steps: [{ label: 'Collect resolver logs' }, { label: 'Compare resolvers' }],
    counterfactualMetrics: { timeToDiagnosisMinutes: { low: 120, mid: 180, high: 300 } },
  };

  it('[FR-TL-06] summarises the simulated path alone, labelled, with no comparison to the real one', () => {
    const summary = decisionTimeSummary(scenario);
    expect(summary).toContain('2026-03-09 09:41 UTC');
    expect(summary).toContain('Collect resolver logs → Compare resolvers');
    expect(summary).toContain('3 h');
    expect(summary).toMatch(/Simulated estimate, not a measurement\.$/);
    expect(summary).not.toMatch(/real case|versus|actual/i);
    expect(decisionTimeSummary({ ...scenario, steps: [] })).toBe(
      'No supported next step could be ranked from 2026-03-09 09:41 UTC.',
    );
    const long = decisionTimeSummary({
      ...scenario,
      steps: ['a', 'b', 'c', 'd'].map((label) => ({ label })),
    });
    expect(long).toContain('a → b → c → …');
    expect(long).toContain('4 steps');
  });

  it('[FR-TL-06] shows a scenario only once its decision instant has been reached', () => {
    const stored = { ...scenario, summary: 'versus 9 h in the real case' };
    expect(scenarioForWindow(null, '2026-03-09T12:00:00Z')).toBeNull();
    expect(scenarioForWindow(stored, null)).toBe(stored);
    expect(scenarioForWindow(stored, '2026-03-09T09:40:59Z')).toBeNull();
    const at = scenarioForWindow(stored, '2026-03-09T09:41:00Z');
    expect(at?.summary).not.toMatch(/real case/);
    expect(at?.steps).toBe(stored.steps);
  });
});
