import type { Hypothesis } from '@caseguard/schemas';
import { describe, expect, it } from 'vitest';
import {
  BEFORE_FORK_EVENT,
  HYP_CA,
  HYP_DNS,
  HYP_PROXY,
  LAST_EVENT,
  actionRanking,
  forkList,
  hypothesesResponse,
  recordedActions,
  reviewerOverride,
  zeroScoreRanking,
} from '../../../test/reasoning-fixtures';
import {
  buildSeries,
  chartMarkers,
  chartedHypotheses,
  cursorView,
  decisionPointView,
  evidenceFor,
  findHypothesis,
  hasNothingToRank,
  latestPoint,
  listedOverrides,
  missingFor,
  overrideEntries,
  peakConfidence,
  sameInstant,
  statusChanges,
  withListedOverrides,
  withheldOverrideCount,
  withheldOverridesText,
} from './model';

const response = hypothesesResponse();
const [dns, proxy, ca] = response.items as [Hypothesis, Hypothesis, Hypothesis];

const flat = (hypothesis: Hypothesis, id: string, confidence: number): Hypothesis => ({
  ...hypothesis,
  id,
  key: `hyp.${id}`,
  name: `Quiet hypothesis ${id}`,
  currentConfidence: confidence,
  timeline: hypothesis.timeline.map((point) => ({ ...point, confidence })),
});

describe('hypothesis model: charting', () => {
  it('reports the highest confidence a hypothesis ever reached', () => {
    expect(peakConfidence(dns)).toBeCloseTo(0.73);
    expect(peakConfidence({ ...dns, timeline: [] })).toBe(0);
  });

  it('draws the serious contenders by default and every hypothesis on request', () => {
    const quiet = [flat(dns, 'q1', 0.03), flat(dns, 'q2', 0.02)];
    const all = [dns, proxy, ca, ...quiet];
    expect(chartedHypotheses(all, null, false).map((h) => h.id)).toEqual([
      HYP_DNS,
      HYP_PROXY,
      HYP_CA,
    ]);
    expect(chartedHypotheses(all, null, true)).toHaveLength(5);
  });

  it('always includes the focused hypothesis, even a quiet one', () => {
    const quiet = flat(dns, 'q1', 0.03);
    const charted = chartedHypotheses([dns, proxy, ca, quiet], 'q1', false);
    expect(charted.map((h) => h.id)).toContain('q1');
  });

  it('falls back to the three most confident hypotheses when fewer than three are contenders', () => {
    const all = [dns, proxy, flat(dns, 'q1', 0.03), flat(dns, 'q2', 0.02)];
    expect(chartedHypotheses(all, null, false).map((h) => h.id)).toEqual([
      HYP_DNS,
      HYP_PROXY,
      'q1',
    ]);
  });

  it('gives only the focused hypothesis a confidence band', () => {
    const series = buildSeries([dns, proxy], HYP_DNS);
    expect(series.map((s) => s.id)).toEqual([HYP_DNS, HYP_PROXY]);
    expect(series[0]?.points[0]).toEqual({
      x: '2026-03-09T09:12:00Z',
      y: 0.18,
      low: 0.11,
      high: 0.25,
    });
    expect(series[1]?.points[0]).toEqual({ x: '2026-03-09T09:12:00Z', y: 0.19 });
  });
});

describe('hypothesis model: chart markers', () => {
  it('merges an action and a fork that share an instant and keeps time order', () => {
    const markers = chartMarkers(recordedActions(), forkList().items);
    expect(markers.map((m) => [m.x, m.kind])).toEqual([
      ['2026-03-09T09:41:00.000Z', 'both'],
      ['2026-03-09T11:40:00.000Z', 'action'],
      ['2026-03-09T12:25:00.000Z', 'fork'],
      ['2026-03-09T12:31:00.000Z', 'action'],
      ['2026-03-11T11:50:00.000Z', 'action'],
    ]);
    expect(markers[0]?.label).toBe(
      'Action: Request HAR and Fiddler traces, full user list and Conditional Access export · Decision fork: Heavy customer request when a lighter ask was available',
    );
  });

  it('returns nothing when nothing is on record yet', () => {
    expect(chartMarkers([], [])).toEqual([]);
  });
});

describe('hypothesis model: evidence and missing evidence', () => {
  it('orders evidence by the size of its effect and separates supporting from contradicting', () => {
    const dnsEvidence = evidenceFor(dns, response.links, response.evidence);
    expect(dnsEvidence.supporting.map((e) => e.evidence.id)).toEqual(['evd_name', 'evd_sites']);
    expect(dnsEvidence.contradicting).toEqual([]);
    const caEvidence = evidenceFor(ca, response.links, response.evidence);
    expect(caEvidence.contradicting.map((e) => e.evidence.id)).toEqual(['evd_policy']);
    expect(caEvidence.contradicting[0]?.link.effectOnConfidence).toBeCloseTo(-0.13);
  });

  it('skips links whose evidence is not in the response and counts neutral links', () => {
    const neutral = { ...response.links[0]!, id: 'hel_neutral', polarity: 'neutral' as const };
    const result = evidenceFor(
      dns,
      [...response.links, neutral],
      response.evidence.filter((e) => e.id !== 'evd_sites'),
    );
    expect(result.supporting.map((e) => e.evidence.id)).toEqual(['evd_name']);
    expect(result.neutralCount).toBe(1);
  });

  it('splits what the pack still needs from what was already collected', () => {
    const forDns = missingFor(dns, response.missing);
    expect(forDns.open.map((m) => m.requirementId)).toEqual(['req.network-path-check']);
    expect(forDns.collected.map((m) => m.requirementId)).toEqual(['req.error-code']);
    expect(missingFor(ca, response.missing)).toEqual({ open: [], collected: [] });
  });
});

describe('hypothesis model: status and selection', () => {
  it('lists the moments a hypothesis changed status, starting with its first', () => {
    const changes = statusChanges(dns.timeline);
    expect(changes.map((c) => [c.from, c.to])).toEqual([
      [null, 'active'],
      ['active', 'leading'],
    ]);
    expect(changes[1]?.eventId).toBe('e04');
    expect(statusChanges(proxy.timeline).map((c) => c.to)).toEqual(['active']);
    expect(statusChanges([])).toEqual([]);
  });

  it('reads the newest point as the state at the boundary', () => {
    expect(latestPoint(dns)?.confidence).toBeCloseTo(0.73);
    expect(latestPoint({ ...dns, timeline: [] })).toBeNull();
  });

  it('finds a hypothesis by record id or by knowledge-pack key and ignores anything else', () => {
    expect(findHypothesis(response.items, HYP_PROXY)?.key).toBe('hyp.proxy-egress');
    expect(findHypothesis(response.items, 'hyp.dns-resolution')?.id).toBe(HYP_DNS);
    expect(findHypothesis(response.items, 'unknown')).toBeUndefined();
    expect(findHypothesis(response.items, null)).toBeUndefined();
  });
});

describe('hypothesis model: the action ranking and its reviewer overrides', () => {
  const WHOLE = '9 Mar 2026, 09:30 UTC';

  it('compares instants as moments, whatever their notation', () => {
    expect(sameInstant('2026-03-09T09:30:00Z', '2026-03-09T09:30:00.000Z')).toBe(true);
    expect(sameInstant('2026-03-09T09:30:00Z', '2026-03-09T09:30:01Z')).toBe(false);
    expect(sameInstant('not a date', 'not a date')).toBe(false);
  });

  it('reads the optional fields of a server that does not send them as none', () => {
    expect(listedOverrides({})).toEqual([]);
    expect(withheldOverrideCount({})).toBe(0);
    expect(withheldOverrideCount({ withheldOverrides: 3 })).toBe(3);
    const listed = [reviewerOverride()];
    expect(listedOverrides({ reviewerOverrides: listed })).toBe(listed);
  });

  it('calls a ranking with candidates whose scores are all zero a list with nothing left to rank', () => {
    expect(hasNothingToRank(zeroScoreRanking())).toBe(true);
    expect(hasNothingToRank(actionRanking())).toBe(false);
    // No candidates at all is a different case (everything is blocked), not a list of zero scores.
    expect(hasNothingToRank({ candidates: [] })).toBe(false);
    const mixed = [...zeroScoreRanking().candidates, ...actionRanking().candidates.slice(0, 1)];
    expect(hasNothingToRank({ candidates: mixed })).toBe(false);
  });

  it('words what a window cannot show with a count and a moment, never with content', () => {
    expect(withheldOverridesText(0, WHOLE)).toBeNull();
    expect(withheldOverridesText(-1, WHOLE)).toBeNull();
    expect(withheldOverridesText(1, WHOLE)).toBe(
      `1 reviewer override recorded later is not shown, because this view only shows what was known at ${WHOLE}.`,
    );
    expect(withheldOverridesText(3, WHOLE)).toBe(
      `3 reviewer overrides recorded later are not shown, because this view only shows what was known at ${WHOLE}.`,
    );
  });

  it('gives the machine rank of an override only when it is about the ranking on screen, and invents none otherwise', () => {
    const ranking = actionRanking({ asOf: BEFORE_FORK_EVENT });
    const own = reviewerOverride({
      instant: '2026-03-09T09:30:00.000Z',
      actionKey: 'act.request-recent-changes',
      rank: 1,
    });
    const earlier = reviewerOverride({
      instant: '2026-03-09T09:12:00.000Z',
      actionKey: 'act.request-recent-changes',
      rank: 3,
    });
    const absent = reviewerOverride({
      instant: '2026-03-09T09:30:00.000Z',
      actionKey: 'act.not-in-this-ranking',
    });
    const entries = overrideEntries([own, earlier, absent], ranking);
    expect(
      entries.map(({ record, machineRank, aboutThisRanking }) => [
        record,
        machineRank,
        aboutThisRanking,
      ]),
    ).toEqual([
      [own, 2, true],
      [earlier, null, false],
      [absent, null, true],
    ]);
  });

  it('puts the override about a ranking on its candidate when the response left it out, and keeps one it carries', () => {
    const ranking = actionRanking({ asOf: BEFORE_FORK_EVENT });
    const record = reviewerOverride({
      instant: '2026-03-09T09:30:00.000Z',
      actionKey: 'act.request-recent-changes',
      rank: 1,
      by: 'user_reviewer',
      reason: 'Ask about changes first.',
    });
    const elsewhere = reviewerOverride({
      instant: '2026-03-09T09:12:00.000Z',
      actionKey: 'act.request-har-capture',
      rank: 1,
    });
    const derived = withListedOverrides(ranking, [record, elsewhere]);
    expect(derived.candidates.map((item) => item.override)).toEqual([
      null,
      { rank: 1, reason: 'Ask about changes first.', by: 'user_reviewer', at: record.at },
      null,
    ]);

    const carried = {
      rank: 3,
      reason: 'Carried by the response.',
      by: 'user_riley_reviewer',
      at: '2026-10-30T05:51:41.391Z',
    };
    const carrying = {
      ...ranking,
      candidates: ranking.candidates.map((item, index) =>
        index === 1 ? { ...item, override: carried } : item,
      ),
    };
    expect(withListedOverrides(carrying, [record]).candidates[1]?.override).toEqual(carried);
  });

  it('describes the whole record as not windowed: every override is listed and none is withheld', () => {
    const ranking = actionRanking({
      reviewerOverrides: [reviewerOverride()],
      withheldOverrides: 4,
    });
    const view = cursorView(ranking, { asOf: null, lastInstant: LAST_EVENT, caseResolved: true });
    expect(view).toMatchObject({
      windowed: false,
      withheld: 0,
      caseResolved: true,
      decisionFork: null,
    });
    expect(view.overrides).toHaveLength(1);
  });

  it('describes an earlier view as windowed, with what it cannot show counted', () => {
    const ranking = actionRanking({ asOf: BEFORE_FORK_EVENT, withheldOverrides: 2 });
    const view = cursorView(ranking, {
      asOf: BEFORE_FORK_EVENT,
      lastInstant: LAST_EVENT,
      caseResolved: true,
    });
    expect(view).toMatchObject({ windowed: true, withheld: 2, atLastEvent: false });
    expect(view.overrides).toEqual([]);
  });

  it('knows a ranking is at the last event from its instant, or from the cursor when the last event is unknown', () => {
    const at = (
      ranking: ReturnType<typeof actionRanking>,
      asOf: string | null,
      last: string | null,
    ) => cursorView(ranking, { asOf, lastInstant: last, caseResolved: false }).atLastEvent;
    expect(at(zeroScoreRanking(), LAST_EVENT, LAST_EVENT)).toBe(true);
    expect(at(actionRanking(), BEFORE_FORK_EVENT, LAST_EVENT)).toBe(false);
    expect(at(zeroScoreRanking(), null, null)).toBe(true);
    expect(at(actionRanking(), BEFORE_FORK_EVENT, null)).toBe(false);
  });

  it('shows the ranking before the earliest fork with the whole record\u2019s list and no note about a window', () => {
    const record = reviewerOverride({
      instant: '2026-03-09T09:30:00.000Z',
      actionKey: 'act.request-recent-changes',
      rank: 1,
    });
    const whole = zeroScoreRanking({ reviewerOverrides: [record], withheldOverrides: 5 });
    const before = actionRanking({ asOf: BEFORE_FORK_EVENT, withheldOverrides: 2 });
    const view = decisionPointView(
      before,
      whole,
      { title: 'Heavy customer request', timestamp: '2026-03-09T09:41:00Z' },
      true,
    );
    expect(view).toMatchObject({
      windowed: false,
      withheld: 0,
      atLastEvent: false,
      caseResolved: true,
      decisionFork: { title: 'Heavy customer request', at: '2026-03-09T09:41:00Z' },
    });
    expect(view.overrides).toEqual([record]);
    expect(view.ranking.candidates[1]?.override).toMatchObject({ rank: 1 });
  });
});
