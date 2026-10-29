import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { CaseEventSchema, type CaseEvent, type CaseResolution } from '@caseguard/schemas';
import {
  assertPreResolution,
  createFullView,
  createTemporalView,
  createTemporalViewBeforeEvent,
  findFutureReferences,
} from '../src';
import { CASE_ONE, prepareCase } from './helpers';

const p = prepareCase(CASE_ONE);
const events = p.normalized.events;
const resolution = p.normalized.resolution as CaseResolution;

describe('temporal views (FR-TL-06, FR-CF-02)', () => {
  it('an as-of view contains only events at or before the boundary', () => {
    const boundary = events[9]?.timestamp ?? '';
    const view = createTemporalView(events, boundary, { resolution });
    expect(view.events.every((e) => e.timestamp <= boundary)).toBe(true);
    expect(view.events.length).toBeGreaterThan(0);
    expect(view.withheldFutureEventCount).toBe(events.length - view.events.length);
  });

  it('never carries the resolution before it has happened', () => {
    const view = createTemporalView(events, events[20]?.timestamp ?? '', { resolution });
    expect(view.resolution).toBeNull();
    const full = createFullView(events, resolution);
    expect(full.resolution?.rootCause).toBe(resolution.rootCause);
  });

  it('the exclusive "before event" view never contains the event itself or anything later', () => {
    for (const event of events) {
      const view = createTemporalViewBeforeEvent(events, event.id);
      expect(view.events.some((e) => e.id === event.id)).toBe(false);
      expect(view.events.every((e) => e.sequence < event.sequence)).toBe(true);
      expect(view.resolution).toBeNull();
    }
  });

  it('assertPreResolution accepts boundary views and rejects a view that carries the resolution', () => {
    const before = createTemporalViewBeforeEvent(events, events[5]?.id ?? '');
    expect(() => assertPreResolution(before)).not.toThrow();
    expect(() => assertPreResolution(createFullView(events, resolution))).toThrow(
      /Temporal integrity/,
    );
  });

  it('findFutureReferences flags ids outside the view', () => {
    const before = createTemporalViewBeforeEvent(events, events[5]?.id ?? '');
    const leak = findFutureReferences(before, [events[2]?.id ?? '', events[10]?.id ?? '']);
    expect(leak).toEqual([events[10]?.id]);
  });

  it('events that share a timestamp are ordered by sequence', () => {
    const twin: CaseEvent[] = [
      { ...(events[0] as CaseEvent), id: 'a', sequence: 0, timestamp: '2026-01-01T00:00:00.000Z' },
      { ...(events[0] as CaseEvent), id: 'b', sequence: 1, timestamp: '2026-01-01T00:00:00.000Z' },
      { ...(events[0] as CaseEvent), id: 'c', sequence: 2, timestamp: '2026-01-01T00:00:00.000Z' },
    ];
    expect(createTemporalViewBeforeEvent(twin, 'b').events.map((e) => e.id)).toEqual(['a']);
  });

  it('property: for any boundary the view is a prefix of the full ordered timeline', () => {
    const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: events.length - 1 }), (index) => {
        const asOf = ordered[index]?.timestamp ?? '';
        const view = createTemporalView(events, asOf);
        const ids = view.events.map((e) => e.id);
        expect(ids).toEqual(ordered.slice(0, ids.length).map((e) => e.id));
        return view.events.every((e) => e.timestamp <= asOf);
      }),
      { numRuns: 40 },
    );
  });

  it('normalised events satisfy the event contract', () => {
    for (const event of events) expect(() => CaseEventSchema.parse(event)).not.toThrow();
  });
});
