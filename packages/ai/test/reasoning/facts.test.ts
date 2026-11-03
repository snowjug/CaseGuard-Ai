import { describe, expect, it } from 'vitest';
import {
  deterministicFactsOf,
  isAtOrBefore,
  isBefore,
  mentions,
  unmetRequirementsAt,
} from '../../src/reasoning/facts';
import { CASE_ONE, CASE_TWO, prepareCase } from '../helpers';
import { viewUpTo } from '../tasks';
import { plainFacts } from './facts-fixture';

const one = prepareCase(CASE_ONE);
const two = prepareCase(CASE_TWO);
const boundary = viewUpTo(one, 'e15');
const inBoundary = new Set(boundary.events.map((e) => e.id));
const afterBoundary = one.normalized.events.filter((e) => !inBoundary.has(e.id));

describe('facts of the engine analysis', () => {
  const facts = deterministicFactsOf(one.analysis);

  it('carry one fact per item the analysis found, and the order of every event of the view', () => {
    expect(Object.keys(facts.eventOrder)).toHaveLength(one.analysis.view.events.length);
    expect(facts.signals).toHaveLength(one.analysis.observations.length);
    expect(facts.actions).toHaveLength(one.analysis.actions.length);
    expect(facts.forks).toHaveLength(one.analysis.forks.length);
    expect(facts.requirements).toHaveLength(one.analysis.missing.length);
    expect(facts.hypotheses).toHaveLength(one.analysis.hypotheses.length);
    expect(facts.conflicts).toBeNull();
    expect(facts.counterfactuals).toEqual([]);
  });

  it('rank the hypotheses by confidence, the leading one first', () => {
    expect(facts.hypotheses.map((h) => h.rank)).toEqual(facts.hypotheses.map((_, i) => i + 1));
    const confidences = facts.hypotheses.map((h) => h.confidence);
    expect(confidences).toEqual([...confidences].sort((a, b) => b - a));
  });

  it('hold plain copies: nothing written to them reaches the analysis', () => {
    const own = deterministicFactsOf(one.analysis);
    const before = JSON.stringify(one.analysis.observations);
    own.signals.length = 0;
    expect(JSON.stringify(one.analysis.observations)).toBe(before);
    expect(deterministicFactsOf(one.analysis).signals.length).toBe(
      one.analysis.observations.length,
    );
  });

  it('carry the modalities, conflicts and counterparts the caller supplies, and only those', () => {
    const observation = one.analysis.observations[0];
    if (!observation) throw new Error('fixture');
    const withExtras = deterministicFactsOf(one.analysis, {
      modalities: { [observation.id]: 'negated' },
      signalCounterparts: { 'sig.a': ['sig.b'], 'sig.b': ['sig.a'] },
      conflicts: [],
    });
    expect(withExtras.signals.find((s) => s.id === observation.id)?.modality).toBe('negated');
    expect(withExtras.signals.filter((s) => s.modality !== null)).toHaveLength(1);
    expect(withExtras.signalCounterparts['sig.a']).toEqual(['sig.b']);
    expect(withExtras.conflicts).toEqual([]);
  });

  it('can be made for the second case too', () => {
    const second = deterministicFactsOf(two.analysis);
    expect(second.signals).toHaveLength(two.analysis.observations.length);
  });

  describe('scoped to the boundary of a view', () => {
    const scoped = deterministicFactsOf(one.analysis, {}, { view: boundary });

    it('is the same as the whole analysis when the view is the whole analysis', () => {
      expect(deterministicFactsOf(one.analysis, {}, { view: one.analysis.view })).toEqual(facts);
    });

    it('knows no event, observation, action, fork or evidence of a later event', () => {
      expect(afterBoundary.length).toBeGreaterThan(0);
      expect(Object.keys(scoped.eventOrder).sort()).toEqual([...inBoundary].sort());
      for (const s of scoped.signals) expect(inBoundary.has(s.eventId)).toBe(true);
      for (const a of scoped.actions) expect(inBoundary.has(a.eventId)).toBe(true);
      for (const f of scoped.forks) expect(inBoundary.has(f.eventId)).toBe(true);
      for (const r of scoped.recommendations)
        for (const id of r.eventIds) expect(inBoundary.has(id)).toBe(true);
      for (const r of scoped.requirements) {
        if (r.resolvedByEventId !== null) expect(inBoundary.has(r.resolvedByEventId)).toBe(true);
      }
      const text = JSON.stringify(scoped);
      for (const event of afterBoundary) expect(text).not.toContain(event.id);
    });

    it('has no more than the whole analysis has', () => {
      expect(scoped.signals.length).toBeLessThanOrEqual(facts.signals.length);
      expect(scoped.actions.length).toBeLessThanOrEqual(facts.actions.length);
      expect(scoped.forks.length).toBeLessThanOrEqual(facts.forks.length);
      expect(scoped.requirements.length).toBeLessThanOrEqual(facts.requirements.length);
    });

    it('reads a requirement that only a later event met as unmet at the boundary', () => {
      const analysis = structuredClone(one.analysis);
      const requirement = analysis.missing[0];
      const first = boundary.events[0];
      const later = afterBoundary[0];
      if (!requirement || !first || !later) throw new Error('fixture');
      requirement.firstRelevantAt = first.timestamp;
      requirement.resolvedAt = later.timestamp;
      requirement.resolvedByEventId = later.id;
      const whole = deterministicFactsOf(analysis);
      expect(whole.requirements.find((r) => r.id === requirement.id)?.resolvedByEventId).toBe(
        later.id,
      );
      const early = deterministicFactsOf(analysis, {}, { view: boundary });
      expect(early.requirements.find((r) => r.id === requirement.id)).toMatchObject({
        resolvedAt: null,
        resolvedByEventId: null,
      });
    });

    it('leaves out a requirement that mattered only after the boundary', () => {
      const analysis = structuredClone(one.analysis);
      const requirement = analysis.missing[0];
      const later = afterBoundary[afterBoundary.length - 1];
      if (!requirement || !later) throw new Error('fixture');
      requirement.firstRelevantAt = later.timestamp;
      const early = deterministicFactsOf(analysis, {}, { view: boundary });
      expect(early.requirements.some((r) => r.id === requirement.id)).toBe(false);
    });

    it('puts a hypothesis where its timeline stood at the boundary', () => {
      const analysis = structuredClone(one.analysis);
      const hypothesis = analysis.hypotheses[0];
      if (!hypothesis) throw new Error('fixture');
      const inside = hypothesis.timeline.filter((p) => inBoundary.has(p.eventId));
      const last = inside[inside.length - 1];
      hypothesis.currentConfidence = 0.99;
      hypothesis.currentStatus = 'confirmed';
      const early = deterministicFactsOf(analysis, {}, { view: boundary });
      const fact = early.hypotheses.find((h) => h.hypothesisId === hypothesis.key);
      expect(fact?.confidence).toBe(last?.confidence ?? hypothesis.prior);
      expect(fact?.status).toBe(last?.status ?? 'active');
      const whole = deterministicFactsOf(analysis);
      expect(whole.hypotheses.find((h) => h.hypothesisId === hypothesis.key)?.status).toBe(
        'confirmed',
      );
    });

    it('drops a conflict, counterfactual or outcome the caller supplies about a later event', () => {
      const later = afterBoundary[0];
      const inside = boundary.events[0];
      if (!later || !inside) throw new Error('fixture');
      const side = (eventId: string) => ({
        eventId,
        participantRole: 'support_engineer' as const,
        timestamp: '2026-03-09T10:00:00.000Z',
        statement: 'A statement.',
        subject: 'sig.x',
        polarity: 'asserts' as const,
        modality: 'asserted' as const,
        sourceRef: { eventId },
      });
      const conflict = (id: string, a: string, b: string) => ({
        id,
        class: 'unresolved_conflict' as const,
        subject: 'cause',
        sides: [side(a), side(b)] as [ReturnType<typeof side>, ReturnType<typeof side>],
        favours: null,
        explanation: 'Two statements disagree.',
        uncertainty: { level: 'low' as const, note: 'Nothing settles it.' },
        ruleId: 'test',
      });
      const early = deterministicFactsOf(
        one.analysis,
        {
          conflicts: [
            conflict('c.in', inside.id, inside.id),
            conflict('c.out', inside.id, later.id),
          ],
          counterfactuals: [
            { id: 'cf.in', forkEventId: inside.id, alternativeActionIds: [], label: 'In' },
            { id: 'cf.out', forkEventId: later.id, alternativeActionIds: [], label: 'Out' },
          ],
        },
        { view: boundary },
      );
      expect(early.conflicts?.map((c) => c.id)).toEqual(['c.in']);
      expect(early.counterfactuals.map((c) => c.id)).toEqual(['cf.in']);
    });
  });
});

describe('reading the facts', () => {
  const facts = plainFacts();

  it('orders events by time, then by sequence', () => {
    expect(isBefore(facts, 'e1', 'e2')).toBe(true);
    expect(isBefore(facts, 'e2', 'e1')).toBe(false);
    expect(isBefore(facts, 'e3', 'e3')).toBe(false);
    const same = plainFacts({
      eventOrder: {
        a: { at: '2026-03-09T09:00:00.000Z', sequence: 1 },
        b: { at: '2026-03-09T09:00:00.000Z', sequence: 2 },
      },
    });
    expect(isBefore(same, 'a', 'b')).toBe(true);
    expect(isBefore(same, 'b', 'a')).toBe(false);
  });

  it('never puts an event the facts do not know before or after anything', () => {
    expect(isBefore(facts, 'zz', 'e1')).toBe(false);
    expect(isBefore(facts, 'e1', 'zz')).toBe(false);
    expect(isAtOrBefore(facts, 'e1', 'zz')).toBe(false);
    expect(isAtOrBefore(facts, 'zz', 'zz')).toBe(true);
    expect(isAtOrBefore(facts, 'e2', 'e2')).toBe(true);
    expect(isAtOrBefore(facts, 'e2', 'e3')).toBe(true);
  });

  it('lists the requirements that mattered and were not yet met when an event happened', () => {
    expect(unmetRequirementsAt(facts, 'e1').map((r) => r.id)).toEqual(['miss.1']);
    expect(unmetRequirementsAt(facts, 'zz')).toEqual([]);
    const base = facts.requirements[0];
    if (!base) throw new Error('fixture');
    const later = plainFacts({
      requirements: [{ ...base, firstRelevantAt: '2026-03-09T10:40:00.000Z' }],
    });
    expect(unmetRequirementsAt(later, 'e3')).toEqual([]);
    expect(unmetRequirementsAt(later, 'e4').map((r) => r.id)).toEqual(['miss.1']);
    const met = plainFacts({
      requirements: [{ ...base, resolvedAt: '2026-03-09T10:30:00.000Z', resolvedByEventId: 'e3' }],
    });
    expect(unmetRequirementsAt(met, 'e3').map((r) => r.id)).toEqual(['miss.1']);
    expect(unmetRequirementsAt(met, 'e4')).toEqual([]);
  });

  describe('naming a label or an id', () => {
    it('finds the label whatever the case and spacing', () => {
      expect(
        mentions('Request a HAR capture from one failing sign-in', 'Request a HAR capture'),
      ).toBe(true);
      expect(mentions('REQUEST   a har\ncapture', 'request a har capture')).toBe(true);
    });

    it('finds the id', () => {
      expect(
        mentions(
          'Run act.dns-resolver-comparison next',
          'Something else',
          'act.dns-resolver-comparison',
        ),
      ).toBe(true);
    });

    it('accepts a text that carries three quarters of the content words of a label of two words or more', () => {
      expect(mentions('delta charlie bravo notes', 'alpha bravo charlie delta')).toBe(true);
      expect(mentions('delta charlie only', 'alpha bravo charlie delta')).toBe(false);
    });

    it('does not accept a one-word label by overlap, nor an unrelated text', () => {
      expect(mentions('Close the case', 'Request a HAR capture')).toBe(false);
      expect(mentions('something about capture', 'capture-x')).toBe(false);
    });

    it('does not take an empty label for a match', () => {
      expect(mentions('anything', '')).toBe(false);
    });
  });
});
