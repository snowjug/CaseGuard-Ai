import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { IdSchema } from '@caseguard/schemas';
import { createMonotonicIdFactory, newId, stableId } from '../src/ids';

const ULID_BODY = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Small deterministic PRNG (mulberry32) so id tests are reproducible. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

describe('newId', () => {
  it('produces <prefix>_<26-char Crockford base32> that satisfies IdSchema', () => {
    const id = newId('case');
    expect(id.startsWith('case_')).toBe(true);
    expect(id.slice('case_'.length)).toMatch(ULID_BODY);
    expect(IdSchema.safeParse(id).success).toBe(true);
  });

  it('is fully deterministic with an injected clock and random source', () => {
    const options = { now: () => 1_700_000_000_000, random: () => 0 };
    expect(newId('evt', options)).toBe('evt_01HF7YAT00' + '0'.repeat(16));
    const make = () => newId('evt', { now: () => 1_700_000_000_000, random: seeded(42) });
    expect(make()).toBe(make());
  });

  it('is time-sortable: later clocks sort lexicographically later', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 47 }),
        fc.integer({ min: 1, max: 2 ** 40 }),
        (start, delta) => {
          const a = newId('x', { now: () => start, random: seeded(1) });
          const b = newId('x', { now: () => start + delta, random: seeded(1) });
          return a < b;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('accepts a Date clock and rejects unusable clocks and prefixes', () => {
    expect(newId('job', { now: () => new Date(0), random: () => 0 })).toBe('job_' + '0'.repeat(26));
    expect(() => newId('job', { now: () => -1 })).toThrow(RangeError);
    expect(() => newId('job', { now: () => Number.NaN })).toThrow(RangeError);
    expect(() => newId('job', { now: () => 2 ** 48 })).toThrow(RangeError);
    for (const bad of ['', 'Case', 'a b', 'a/b', '_x', 'x_', 'x__y', '1x', 'a'.repeat(33)]) {
      expect(() => newId(bad), bad).toThrow(TypeError);
    }
    expect(IdSchema.safeParse(newId('audit_event')).success).toBe(true);
  });

  it('does not collide across many draws', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => newId('k', { now: () => 5 })));
    expect(ids.size).toBe(5000);
  });

  it('survives a misbehaving random source', () => {
    const id = newId('k', { now: () => 1, random: () => Number.NaN });
    expect(id.slice(2)).toMatch(ULID_BODY);
    const high = newId('k', { now: () => 1, random: () => 1.5 });
    expect(high.slice(2)).toMatch(ULID_BODY);
  });
});

describe('createMonotonicIdFactory', () => {
  it('keeps ids strictly increasing within one millisecond', () => {
    const next = createMonotonicIdFactory({ now: () => 1000, random: seeded(7) });
    const ids = Array.from({ length: 200 }, () => next('evt'));
    for (let i = 1; i < ids.length; i += 1) expect(ids[i]! > ids[i - 1]!).toBe(true);
  });

  it('never goes backwards when the clock does', () => {
    let clock = 5000;
    const next = createMonotonicIdFactory({ now: () => clock, random: seeded(3) });
    const first = next('evt');
    clock = 4000;
    const second = next('evt');
    expect(second > first).toBe(true);
  });

  it('carries into the time part when the random part is exhausted', () => {
    const next = createMonotonicIdFactory({ now: () => 0, random: () => 0.999999 });
    const first = next('evt'); // random part is all "Z"
    const second = next('evt');
    expect(first.endsWith('Z'.repeat(16))).toBe(true);
    expect(second > first).toBe(true);
    expect(second.slice(4)).toMatch(ULID_BODY);
  });
});

describe('stableId', () => {
  it('[NFR-REL-01] is deterministic: same parts give the same id', () => {
    expect(stableId('hyp', 'case_1', 'leading')).toBe(stableId('hyp', 'case_1', 'leading'));
  });

  it('depends on every part and on their order', () => {
    const base = stableId('hyp', 'case_1', 'leading');
    expect(stableId('hyp', 'case_2', 'leading')).not.toBe(base);
    expect(stableId('hyp', 'leading', 'case_1')).not.toBe(base);
    expect(stableId('fork', 'case_1', 'leading')).not.toBe(base);
    expect(stableId('hyp', 'case_1', 'leading', 'x')).not.toBe(base);
  });

  it('does not confuse part boundaries', () => {
    expect(stableId('k', 'ab', 'c')).not.toBe(stableId('k', 'a', 'bc'));
    expect(stableId('k', 1)).not.toBe(stableId('k', '1'));
  });

  it('ignores object key order and satisfies IdSchema', () => {
    const a = stableId('scn', { b: 2, a: 1 });
    expect(a).toBe(stableId('scn', { a: 1, b: 2 }));
    expect(a.slice('scn_'.length)).toMatch(/^[0-9A-HJKMNP-TV-Z]{24}$/);
    expect(IdSchema.safeParse(a).success).toBe(true);
  });

  it('keeps ids stable across releases (pinned vector)', () => {
    // Independently derived: base32(first 15 bytes of sha256('["tenant_contoso_support","CASE-1"]')).
    expect(stableId('case', 'tenant_contoso_support', 'CASE-1')).toBe(
      'case_DDAEVTXK5PD0BCFB99NJRXPH',
    );
  });

  it('rejects invalid prefixes and unserializable parts', () => {
    expect(() => stableId('Bad Prefix', 'x')).toThrow(TypeError);
    expect(() => stableId('k', Number.NaN)).toThrow(TypeError);
  });

  it('property: always yields a valid id for arbitrary JSON parts', () => {
    fc.assert(
      fc.property(fc.array(fc.jsonValue(), { maxLength: 5 }), (parts) => {
        const id = stableId('p', ...parts);
        return IdSchema.safeParse(id).success && id.length === 'p_'.length + 24;
      }),
      { numRuns: 100 },
    );
  });
});
