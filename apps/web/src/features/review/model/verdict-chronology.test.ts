import type { DecisionFork, ForkListResponse, TimelineEvent } from '@caseguard/schemas';
import { describe, expect, it } from 'vitest';
import { CASE_ONE, CASE_TWO } from '../../../../test/review-fixtures';
import { chronologyRows, compressedPositions, deriveChronology, laneOfRole } from './chronology';
import { earliestFork, orderForks } from './forks';
import { describeProducer, deriveEffort, deriveMissedMoment, deriveVerdict } from './verdict';

const verdictOf = (fixture: typeof CASE_ONE) =>
  deriveVerdict({
    quality: fixture.quality,
    coaching: fixture.coaching,
    forks: fixture.forks,
    detail: fixture.detail,
    metrics: fixture.metrics,
  });

describe('[REV-VERDICT-01] the verdict', () => {
  it('states the band, the score and its range as an estimate, from the figures of the case', () => {
    const verdict = verdictOf(CASE_ONE);
    expect(verdict.band).toBe('poor');
    expect(verdict.bandLabel).toBe('Poor');
    expect(verdict.scoreText).toBe('36 out of 100');
    expect(verdict.rangeText).toBe('plausible range 32 to 39');
    expect(verdict.headline).toBe(
      'Case quality is poor: about 36 out of 100 (plausible range 32 to 39). This is an estimate.',
    );
    expect(verdict.facts).toEqual([
      '9 decision points had a better-supported step available at the time.',
      'The case is resolved, so this reviews the whole record.',
    ]);
    expect(verdict.coachingSummary).toBe(CASE_ONE.coaching.summary);
    expect(verdict.configVersion).toBe('1.0.0');
    expect(verdict.placeholder).toBe(false);
  });

  it('says plainly when no decision point stood out, and reads a strong case as strong', () => {
    const verdict = verdictOf(CASE_TWO);
    expect(verdict.bandLabel).toBe('Strong');
    expect(verdict.badge).toBe('productive');
    expect(verdict.facts[0]).toBe(
      'No decision point stood out as having a clearly better step available.',
    );
  });

  it('is honest about an open case and about parts it was not given', () => {
    const open = deriveVerdict({
      quality: CASE_ONE.quality,
      coaching: null,
      forks: null,
      detail: { ...CASE_ONE.detail, status: 'open' },
      metrics: null,
    });
    expect(open.facts).toEqual(['The case is still open, so this reviews the record so far.']);
    expect(open.coachingSummary).toBeNull();
    expect(open.effort).toBeNull();
  });

  it('does not present a placeholder score as a result when nothing could be assessed', () => {
    const nothing = deriveVerdict({
      quality: {
        ...CASE_ONE.quality,
        dimensions: CASE_ONE.quality.dimensions.map((d) => ({ ...d, weight: 0 })),
      },
      coaching: null,
      forks: null,
      detail: CASE_ONE.detail,
      metrics: null,
    });
    expect(nothing.placeholder).toBe(true);
  });

  it('reads the avoidable support effort with its own range and says how sure the analysis is', () => {
    expect(deriveEffort(CASE_ONE.metrics)).toEqual({
      display: '55% (estimate)',
      rangeText: '44% to 83%',
      confidenceLabel: 'low confidence',
    });
    expect(deriveEffort([])).toBeNull();
  });

  it('names who or what produced the analysis, from the run and nothing else', () => {
    expect(describeProducer(CASE_ONE.run)).toEqual({
      kind: 'rules',
      sentence:
        'Fixed rules produced this review (the kp.teams-authentication version 1.0.0 knowledge pack). No language model was involved.',
    });
    const model = describeProducer({ ...CASE_ONE.run, provider: 'azure-openai', model: 'gpt-x' });
    expect(model.kind).toBe('model');
    expect(model.sentence).toContain('gpt-x');
    // The rules produce every figure in either mode; a model's proposals are never described as part of the result.
    expect(model.sentence).toMatch(/^Fixed rules produced every figure in this review/);
    expect(model.sentence).toContain('none of them is part of these results');
    expect(model.sentence).not.toMatch(/produced parts of this review/);
    expect(describeProducer(null).kind).toBe('unknown');
  });
});

describe('[REV-VERDICT-02] the earliest important missed moment', () => {
  it('is the decision point the engine marks as earliest, with what was done and what was known', () => {
    const moment = deriveMissedMoment(CASE_ONE.forks);
    expect(moment).toMatchObject({
      eventId: 'e03',
      at: '2026-03-09T09:41:00Z',
      title: 'Heavy customer request when a lighter ask was available',
      didLabel: 'Request HAR and Fiddler traces, full user list and Conditional Access export',
      betterLabel: 'Ask for minimal scoping data',
    });
    expect(moment?.knownSummary).toMatch(/^2 events and 2 evidence items were on record\./);
    expect(moment?.knownLinks.map((l) => `${l.type}:${l.id}`)).toEqual([
      'event:e01',
      'event:e02',
      'evidence:evd_d3340201da14f37674629ae2',
      'evidence:evd_061012c02e75f1b32675a052',
    ]);
  });

  it('is null when no decision point stood out', () => {
    expect(deriveMissedMoment(CASE_TWO.forks)).toBeNull();
  });

  it('finds the earliest by the id the engine names, whatever order the list arrives in', () => {
    const reversed: ForkListResponse = {
      ...CASE_ONE.forks,
      items: [...CASE_ONE.forks.items].reverse(),
    };
    expect(orderForks(reversed.items)[0]?.id).toBe(CASE_ONE.forks.earliestMeaningfulForkId);
    expect(earliestFork(reversed)?.id).toBe(CASE_ONE.forks.earliestMeaningfulForkId);
    const second = orderForks(CASE_ONE.forks.items)[1] as DecisionFork;
    const named = earliestFork({
      items: CASE_ONE.forks.items.map((f) => ({ ...f, isEarliestMeaningful: false })),
      earliestMeaningfulForkId: second.id,
    });
    expect(named?.id).toBe(second.id);
  });
});

describe('[REV-CHRONO-01] the chronology', () => {
  const one = deriveChronology(
    CASE_ONE.timeline.events,
    CASE_ONE.forks,
    CASE_ONE.detail.resolution?.resolvedAt,
  );

  it('keeps the first and last event, the decision points, escalations, validation and the resolution', () => {
    expect(one.total).toBe(31);
    expect(one.events.map((e) => e.id)).toEqual([
      'e01',
      'e03',
      'e07',
      'e08',
      'e09',
      'e11',
      'e13',
      'e15',
      'e16',
      'e19',
      'e21',
      'e29',
      'e30',
      'e31',
    ]);
    expect(one.events[0]?.reasons).toEqual(['opened']);
    expect(one.events.find((e) => e.id === 'e19')?.reasons).toEqual(['decision', 'escalation']);
    expect(one.events.at(-1)?.reasons).toEqual(['closed']);
    expect(one.events.at(-1)?.position).toBe(1);
    expect(one.events[0]?.position).toBe(0);
    expect(one.otherPositions).toHaveLength(31 - 14);
    expect(one.resolved).toBe(true);
  });

  it('numbers the decision points from the earliest and puts the number on the event where it was taken', () => {
    expect(one.decisionPoints.map((p) => p.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(one.decisionPoints[0]).toMatchObject({ eventId: 'e03' });
    expect(one.events.find((e) => e.id === 'e08')?.decisionNumbers).toEqual([3]);
  });

  it('tells each meaningful wait in words, from the timestamps and the sides of the two events', () => {
    expect(one.waits.map((w) => [w.toEventId, w.minutes, w.text])).toEqual([
      ['e15', 910, 'The customer waited 15 hours 10 minutes for a reply.'],
      ['e17', 270, 'The engineer waited 4 hours 30 minutes for the customer.'],
      ['e21', 830, 'Nothing was recorded for 13 hours 50 minutes.'],
      ['e28', 1085, 'The engineer waited 18 hours 5 minutes for the customer.'],
    ]);
    // The engine's own delay figures agree with the ones measured from the timestamps.
    expect(one.waits.map((w) => w.minutes)).toEqual(CASE_ONE.timeline.delays.map((d) => d.minutes));
  });

  it('lays the events and the waits in one time order, a wait after an event it starts at', () => {
    const rows = chronologyRows(one).map((row) =>
      row.kind === 'event' ? row.event.id : `wait→${row.wait.toEventId}`,
    );
    expect(rows.indexOf('wait→e15')).toBeGreaterThan(rows.indexOf('e13'));
    expect(rows.indexOf('wait→e15')).toBeLessThan(rows.indexOf('e15'));
    expect(rows.indexOf('wait→e17')).toBe(rows.indexOf('e16') + 1);
    expect(rows).toHaveLength(14 + 4);
  });

  it('writes a text alternative that carries the same story', () => {
    expect(one.summary).toBe(
      '31 events over 3 days 1 hour, from 9 Mar 2026, 09:12 UTC to 12 Mar 2026, 10:20 UTC. 14 key events listed below. 9 decision points where a better-supported step was available. 4 meaningful waits; the longest: the engineer waited 18 hours 5 minutes for the customer.',
    );
  });

  it('has no waits and no decision points for the efficient case, and still lists its key events', () => {
    const two = deriveChronology(CASE_TWO.timeline.events, CASE_TWO.forks);
    expect(two.total).toBe(15);
    expect(two.waits).toEqual([]);
    expect(two.decisionPoints).toEqual([]);
    expect(two.events.map((e) => e.reasons[0])).toContain('validation');
    expect(two.summary).toContain('No decision point stood out.');
    expect(two.summary).toContain('No meaningful waits.');
  });

  it('copes with a case that has no event and with events at a single instant', () => {
    expect(deriveChronology([], null).summary).toBe('No events were recorded for this case.');
    const at = '2026-03-09T09:12:00Z';
    const same: TimelineEvent[] = CASE_ONE.timeline.events
      .slice(0, 2)
      .map((e) => ({ ...e, timestamp: at, isDelay: false }));
    const flat = deriveChronology(same, null);
    expect(flat.events.map((e) => e.position)).toEqual([0, 1]);
    expect(deriveChronology(same.slice(0, 1), null).events.map((e) => e.position)).toEqual([0.5]);
  });

  it('spaces the strip on a compressed scale: a burst stays readable and a long wait stays long, but not to scale', () => {
    const positions = compressedPositions(
      [...CASE_ONE.timeline.events].sort((a, b) => a.sequence - b.sequence),
    );
    const ids = CASE_ONE.timeline.events.map((e) => e.id);
    const values = ids.map((id) => positions.get(id) ?? Number.NaN);
    expect(values[0]).toBe(0);
    expect(values.at(-1)).toBe(1);
    expect(values.every((value, i) => i === 0 || value > (values[i - 1] ?? 0))).toBe(true);
    const gap = (from: string, to: string): number =>
      (positions.get(to) ?? 0) - (positions.get(from) ?? 0);
    // e07, e08, e09 are 15 and 6 minutes apart: close, but apart. e14 to e15 is 910 minutes.
    expect(gap('e07', 'e08')).toBeGreaterThan(0.01);
    expect(gap('e14', 'e15')).toBeGreaterThan(gap('e07', 'e08') * 2);
    expect(gap('e14', 'e15')).toBeLessThan(gap('e07', 'e08') * (910 / 15));
  });

  it('puts every role in the lane of its side', () => {
    expect(laneOfRole('customer_admin')).toBe('customer');
    expect(laneOfRole('customer_network_admin')).toBe('customer');
    expect(laneOfRole('support_engineer')).toBe('engineer');
    expect(laneOfRole('escalation_engineer')).toBe('engineer');
    expect(laneOfRole('support_manager')).toBe('engineer');
    expect(laneOfRole('system')).toBe('system');
  });
});
