import { describe, expect, it } from 'vitest';
import {
  createTemporalView,
  evaluateLiveWarnings,
  replayWarnings,
  runDeterministicAnalysis,
  viewWarningsAsOf,
  type WarningReplay,
} from '../src';
import { CASE_ONE, CONFIG, eventBySuffix, prepareCase } from './helpers';
import { poisonAfter, poisonResolution } from './quality-fixtures';

const one = prepareCase(CASE_ONE);
const at = (iso: string): number => Date.parse(iso);

const fullReplay = replayWarnings({
  events: one.normalized.events,
  resolution: one.normalized.resolution,
  pack: one.pack,
  ctx: one.ctx,
  analysis: one.analysis,
});

const asOfReplay = (
  asOf: string,
  events = one.normalized.events,
  resolution = one.normalized.resolution,
) => replayWarnings({ events, resolution, pack: one.pack, ctx: one.ctx, asOf });

const BETWEEN_EVENTS = '2026-03-09T22:30:00Z';
const CUTS = ['e07', 'e08', 'e15', 'e19'];

describe('strict as-of semantics (FR-LQ-02, FR-TL-06)', () => {
  for (const suffix of CUTS) {
    it(`[FR-LQ-02] replaying as of ${suffix} equals the full replay seen at that moment`, () => {
      const asOf = eventBySuffix(one, suffix).timestamp;
      const prefix = asOfReplay(asOf);
      expect(prefix.asOf).toBe(asOf);
      expect(prefix.evaluatedAt).toBe(asOf);
      expect(prefix.warnings).toEqual(viewWarningsAsOf(fullReplay.warnings, asOf));
      for (const w of prefix.warnings) expect(at(w.raisedAt)).toBeLessThanOrEqual(at(asOf));
    });
  }

  it('[FR-LQ-02] a moment between two events includes the waiting-time warning that fell due in between', () => {
    const prefix = asOfReplay(BETWEEN_EVENTS);
    expect(prefix.warnings).toEqual(viewWarningsAsOf(fullReplay.warnings, BETWEEN_EVENTS));
    const open = prefix.open.map((w) => w.fingerprint);
    expect(open).toContain('LQ-COM-01|e14:4h');
    expect(open).not.toContain('LQ-COM-01|e14:24h');
    expect(
      at(prefix.open.find((w) => w.fingerprint === 'LQ-COM-01|e14:4h')?.raisedAt ?? ''),
    ).toBeLessThanOrEqual(at(BETWEEN_EVENTS));
  });

  it('[FR-LQ-02] a warning that is due exactly at the boundary is included, one a moment later is not', () => {
    const due = '2026-03-09T21:45:00Z';
    const justBefore = '2026-03-09T21:44:59Z';
    expect(asOfReplay(due).open.map((w) => w.fingerprint)).toContain('LQ-COM-01|e14:4h');
    expect(asOfReplay(justBefore).warnings.map((w) => w.fingerprint)).not.toContain(
      'LQ-COM-01|e14:4h',
    );
  });

  it('[FR-LQ-02] before the first event there is nothing to warn about', () => {
    const early = asOfReplay('2026-03-09T08:00:00Z');
    expect(early.warnings).toEqual([]);
    expect(early.checkpoints).toBe(0);
  });

  it('[FR-LQ-02] as of the end of the case the replay equals the full one', () => {
    const last = one.normalized.events.at(-1)?.timestamp ?? '';
    const prefix = asOfReplay(last);
    expect(prefix.warnings).toEqual(fullReplay.warnings);
    expect(prefix.counts).toEqual(fullReplay.counts);
  });

  it('[FR-LQ-02] seen as of any event, warnings are raised by then and resolutions that came later are not yet known', () => {
    for (const event of one.normalized.events) {
      const view = viewWarningsAsOf(fullReplay.warnings, event.timestamp);
      for (const w of view) {
        expect(at(w.raisedAt)).toBeLessThanOrEqual(at(event.timestamp));
        if (w.state === 'resolved')
          expect(at(w.resolvedAt ?? '')).toBeLessThanOrEqual(at(event.timestamp));
        if (w.state === 'open') expect(w.resolvedAt).toBeNull();
      }
      expect(view.map((w) => w.rank)).toEqual(view.map((_, i) => i + 1));
    }
  });
});

describe('the future cannot change earlier warnings (FR-LQ-02, FR-TL-06)', () => {
  for (const suffix of ['e08', 'e15', 'e19']) {
    it(`[FR-LQ-02] mutating everything after ${suffix} changes nothing that was raised by then`, () => {
      const cut = one.normalized.events.findIndex((e) => e.id.endsWith(suffix));
      const asOf = eventBySuffix(one, suffix).timestamp;
      const poisonedEvents = poisonAfter(one.normalized.events, cut);
      const poisonedResolution = poisonResolution(one.normalized.resolution);

      const original = asOfReplay(asOf);
      const poisonedAsOf = asOfReplay(asOf, poisonedEvents, poisonedResolution);
      expect(poisonedAsOf.warnings).toEqual(original.warnings);
      expect(poisonedAsOf.transitions).toEqual(original.transitions);

      const poisonedFull = replayWarnings({
        events: poisonedEvents,
        resolution: poisonedResolution,
        pack: one.pack,
        ctx: one.ctx,
      });
      expect(viewWarningsAsOf(poisonedFull.warnings, asOf)).toEqual(
        viewWarningsAsOf(fullReplay.warnings, asOf),
      );
    });
  }

  it('[FR-LQ-02] the poisoned future really is different, so the check above is not vacuous', () => {
    const cut = one.normalized.events.findIndex((e) => e.id.endsWith('e08'));
    const poisoned = replayWarnings({
      events: poisonAfter(one.normalized.events, cut),
      resolution: poisonResolution(one.normalized.resolution),
      pack: one.pack,
      ctx: one.ctx,
    });
    expect(poisoned.warnings.map((w) => w.fingerprint)).not.toEqual(
      fullReplay.warnings.map((w) => w.fingerprint),
    );
  });
});

describe('one analysis restricted per checkpoint matches a fresh analysis of the prefix (FR-LQ-02)', () => {
  for (const suffix of ['e03', 'e07', 'e08', 'e15', 'e19']) {
    it(`[FR-LQ-02] at ${suffix} the open warnings equal those of a single evaluation on the prefix`, () => {
      const event = eventBySuffix(one, suffix);
      const view = createTemporalView(one.normalized.events, event.timestamp);
      const prefixAnalysis = runDeterministicAnalysis({
        view,
        pack: one.pack,
        config: CONFIG,
        ctx: one.ctx,
      });
      const single = evaluateLiveWarnings({
        analysis: prefixAnalysis,
        pack: one.pack,
        ctx: one.ctx,
      });
      const replayed = viewWarningsAsOf(fullReplay.warnings, event.timestamp).filter(
        (w) => w.state === 'open',
      );
      expect(single.open.map((w) => w.fingerprint).sort()).toEqual(
        replayed.map((w) => w.fingerprint).sort(),
      );
      for (const w of single.open) {
        const match = replayed.find((r) => r.fingerprint === w.fingerprint);
        expect(match?.priority).toBe(w.priority);
        expect(match?.category).toBe(w.category);
        expect(match?.ruleId).toBe(w.ruleId);
        // Warnings raised at this very event carry exactly the text a live evaluation would show.
        if (
          at(w.raisedAt) === at(event.timestamp) &&
          match &&
          at(match.raisedAt) === at(event.timestamp)
        ) {
          expect(match.message).toBe(w.message);
          expect(match.suggestedAction).toBe(w.suggestedAction);
          expect(match.evidence).toEqual(w.evidence);
        }
      }
    });
  }
});

describe('replay result shape (FR-LQ-02)', () => {
  it('[FR-LQ-02] is a pure function of its inputs', () => {
    const asOf = eventBySuffix(one, 'e15').timestamp;
    const a: WarningReplay = asOfReplay(asOf);
    expect(asOfReplay(asOf)).toEqual(a);
  });
});
