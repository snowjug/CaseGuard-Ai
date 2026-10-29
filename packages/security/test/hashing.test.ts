import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { GENESIS_HASH, canonicalJson, hashChain, sha256Hex } from '../src/hashing';

describe('sha256Hex', () => {
  it('matches published SHA-256 test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes strings as UTF-8 and bytes identically', () => {
    expect(sha256Hex('héllo ✓')).toBe(sha256Hex(new TextEncoder().encode('héllo ✓')));
  });
});

describe('canonicalJson', () => {
  it('sorts keys at every depth and emits no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('drops undefined properties but keeps null, and maps undefined array items to null', () => {
    expect(canonicalJson({ a: undefined, b: null, c: [undefined, 1] })).toBe(
      '{"b":null,"c":[null,1]}',
    );
  });

  it('is stable for equal data regardless of key insertion order', () => {
    expect(canonicalJson({ x: 1, y: { p: 1, q: 2 } })).toBe(
      canonicalJson({ y: { q: 2, p: 1 }, x: 1 }),
    );
  });

  it('normalizes negative zero and serializes dates through toJSON', () => {
    expect(canonicalJson([-0, 0])).toBe('[0,0]');
    expect(canonicalJson({ at: new Date('2025-01-02T03:04:05.000Z') })).toBe(
      '{"at":"2025-01-02T03:04:05.000Z"}',
    );
  });

  it('escapes strings exactly like JSON.stringify, including lone surrogates', () => {
    const tricky = 'quote " backslash \\ newline \n unicode \u2028 lone \ud800';
    expect(canonicalJson(tricky)).toBe(JSON.stringify(tricky));
  });

  it('rejects values that have no stable JSON form instead of changing them', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow(/NaN and Infinity/);
    expect(() => canonicalJson([Number.NEGATIVE_INFINITY])).toThrow(TypeError);
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(TypeError);
    expect(() => canonicalJson({ s: Symbol('x') })).toThrow(TypeError);
    expect(() => canonicalJson({ b: 10n })).toThrow(TypeError);
    expect(() => canonicalJson(new Map([['a', 1]]))).toThrow(/plain objects/);
    expect(() => canonicalJson(new Set([1]))).toThrow(TypeError);
  });

  it('rejects cycles but allows shared (non-circular) references', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/circular/);

    const shared = { v: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"v":1},"b":{"v":1}}');
  });

  it('refuses pathologically deep structures', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 400; i += 1) deep = [deep];
    expect(() => canonicalJson(deep)).toThrow(RangeError);
  });

  it('treats keys that look like prototype hooks as ordinary data', () => {
    const parsed: unknown = JSON.parse('{"__proto__":{"polluted":true},"a":1}');
    expect(canonicalJson(parsed)).toBe('{"__proto__":{"polluted":true},"a":1}');
  });

  it('property: round-trips JSON values and ignores key order', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const text = canonicalJson(value);
        expect(canonicalJson(JSON.parse(text))).toBe(text);
        return true;
      }),
      { numRuns: 200 },
    );

    const reorder = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reorder);
      if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .reverse()
            .map(([k, v]) => [k, reorder(v)]),
        );
      }
      return value;
    };
    fc.assert(
      fc.property(
        fc.jsonValue(),
        (value) => canonicalJson(value) === canonicalJson(reorder(value)),
      ),
      { numRuns: 200 },
    );
  });
});

describe('hashChain', () => {
  it('is sha256(prevHash + newline + canonicalJson(payload))', () => {
    const payload = { actor: 'user_a', action: 'case.read', at: '2025-01-01T00:00:00.000Z' };
    expect(hashChain(GENESIS_HASH, payload)).toBe(
      sha256Hex(`${GENESIS_HASH}\n${canonicalJson(payload)}`),
    );
  });

  it('[NFR-SEC-07] changes when the payload, the predecessor or the order changes', () => {
    const first = hashChain(GENESIS_HASH, { n: 1 });
    const second = hashChain(first, { n: 2 });
    expect(hashChain(GENESIS_HASH, { n: 2 })).not.toBe(first);
    expect(hashChain(hashChain(GENESIS_HASH, { n: 2 }), { n: 1 })).not.toBe(second);
    expect(hashChain(first, { n: 3 })).not.toBe(second);
    // Key order of the payload must not matter: the chain verifies after a JSON round trip.
    expect(hashChain(first, { b: 2, a: 1 })).toBe(hashChain(first, { a: 1, b: 2 }));
  });

  it('exposes a 64-character genesis hash', () => {
    expect(GENESIS_HASH).toMatch(/^0{64}$/);
  });
});
