import { describe, expect, it } from 'vitest';
import { SemanticCache, type CacheScope } from '../src';
import { countMapIteration } from './count-work';
import { FakeClock, capturingMetrics } from './fakes';

const usage = {
  promptTokens: 100,
  completionTokens: 20,
  cachedTokens: 0,
  totalTokens: 120,
  source: 'measured',
} as const;
const meta = { provider: 'azure-openai', model: 'gpt-test', usage } as const;

const scope = (patch: Partial<CacheScope> = {}): CacheScope => ({
  tenantId: 'tenant_a',
  caseId: 'case_1',
  agent: 'timeline_analyzer',
  promptHash: 'a'.repeat(64),
  packVersion: 'kp.teams@1.0.0',
  boundaryKey: 'at:2026-03-09T09:12:00Z:fp1|gpt-test',
  structureKey: 's'.repeat(64),
  ...patch,
});

const input = (text: string, hash = text) => ({ hash, text });

function cacheOf(
  options: {
    ttlSeconds?: number;
    similarityThreshold?: number;
    enabled?: boolean;
    maxEntries?: number;
  } = {},
) {
  const clock = new FakeClock();
  const metrics = capturingMetrics();
  const cache = new SemanticCache<{ answer: string }>({
    clock,
    enabled: options.enabled ?? true,
    ttlSeconds: options.ttlSeconds ?? 60,
    similarityThreshold: options.similarityThreshold ?? 0.9,
    maxEntries: options.maxEntries ?? 100,
    metrics,
  });
  return { cache, clock, metrics };
}

describe('SemanticCache [FR-TK-02]', () => {
  it('[NFR-SEC-01] never shares entries across tenants, even for identical input', () => {
    const { cache } = cacheOf();
    cache.set(
      scope(),
      input('the sign-in logs show failures'),
      { answer: 'tenant A answer' },
      meta,
    );
    expect(cache.get(scope(), input('the sign-in logs show failures'))?.value).toEqual({
      answer: 'tenant A answer',
    });
    expect(
      cache.get(scope({ tenantId: 'tenant_b' }), input('the sign-in logs show failures')),
    ).toBeNull();
    expect(cache.clearTenant('tenant_b')).toBe(0);
    expect(cache.get(scope(), input('the sign-in logs show failures'))).not.toBeNull();
    expect(cache.clearTenant('tenant_a')).toBe(1);
  });

  it('[NFR-SEC-01] is also scoped by case, agent, prompt version, knowledge pack and temporal boundary', () => {
    const { cache } = cacheOf();
    cache.set(scope(), input('same text'), { answer: 'x' }, meta);
    for (const patch of [
      { caseId: 'case_2' },
      { agent: 'quality_judge' as const },
      { promptHash: 'b'.repeat(64) },
      { packVersion: 'kp.teams@2.0.0' },
      { boundaryKey: 'at:2026-03-10T00:00:00Z:fp2|gpt-test' },
      { structureKey: 't'.repeat(64) },
    ]) {
      expect(cache.get(scope(patch), input('same text')), JSON.stringify(patch)).toBeNull();
    }
  });

  it('[FR-TK-02] entries expire after the TTL', () => {
    const { cache, clock } = cacheOf({ ttlSeconds: 60 });
    cache.set(scope(), input('hello world'), { answer: 'x' }, meta);
    clock.advance(59_000);
    expect(cache.get(scope(), input('hello world'))).not.toBeNull();
    clock.advance(2_000);
    expect(cache.get(scope(), input('hello world'))).toBeNull();
    expect(cache.stats()).toMatchObject({ expirations: 1, size: 0 });
  });

  it('[FR-TK-02] serves a lexical near-match above the threshold, never below it', () => {
    const { cache } = cacheOf({ similarityThreshold: 0.8 });
    const base =
      'customer reports intermittent teams sign in failures at two branch offices since morning';
    cache.set(scope(), input(base, 'hash-a'), { answer: 'x' }, meta);
    const near = cache.get(scope(), input(`${base} today`, 'hash-b'));
    expect(near?.kind).toBe('near');
    expect(near?.similarity).toBeGreaterThanOrEqual(0.8);
    expect(
      cache.get(
        scope(),
        input('completely different text about proxy inspection policy', 'hash-c'),
      ),
    ).toBeNull();
    const exactOnly = cacheOf({ similarityThreshold: 1 });
    exactOnly.cache.set(scope(), input(base, 'hash-a'), { answer: 'x' }, meta);
    expect(exactOnly.cache.get(scope(), input(`${base} today`, 'hash-b'))).toBeNull();
  });

  it('[FR-TK-02] returns copies, so callers cannot corrupt cached values', () => {
    const { cache } = cacheOf();
    cache.set(scope(), input('abc def ghi'), { answer: 'x' }, meta);
    const hit = cache.get(scope(), input('abc def ghi'));
    if (hit) hit.value.answer = 'mutated';
    expect(cache.get(scope(), input('abc def ghi'))?.value.answer).toBe('x');
  });

  it('[FR-TK-02] reports hit and miss metrics and statistics', () => {
    const { cache, metrics } = cacheOf();
    cache.get(scope(), input('nothing cached yet'));
    cache.set(scope(), input('cached text here'), { answer: 'x' }, meta);
    cache.get(scope(), input('cached text here'));
    expect(metrics.sum('ai.cache.miss')).toBe(1);
    expect(metrics.sum('ai.cache.hit', { kind: 'exact' })).toBe(1);
    expect(cache.stats()).toMatchObject({ hits: 1, exactHits: 1, misses: 1, size: 1 });
  });

  it('[FR-TK-02] invalidates explicitly, including when the prompt or knowledge-pack version changes', () => {
    const { cache } = cacheOf();
    cache.set(scope(), input('one'), { answer: '1' }, meta);
    cache.set(scope({ promptHash: 'b'.repeat(64) }), input('two'), { answer: '2' }, meta);
    cache.set(scope({ packVersion: 'kp.teams@2.0.0' }), input('three'), { answer: '3' }, meta);
    cache.set(scope({ tenantId: 'tenant_b' }), input('four'), { answer: '4' }, meta);
    expect(cache.invalidate({ tenantId: 'tenant_a', promptHash: 'b'.repeat(64) })).toBe(1);
    expect(
      cache.purgeStale({
        promptHashes: new Set(['a'.repeat(64)]),
        packVersions: new Set(['kp.teams@1.0.0']),
      }),
    ).toBe(1);
    expect(cache.stats().size).toBe(2);
    expect(cache.invalidate({ agent: 'timeline_analyzer' })).toBe(2);
  });

  it('[FR-TK-02] bounds memory by evicting the least recently used entry', () => {
    const { cache, clock } = cacheOf({ maxEntries: 2 });
    cache.set(scope(), input('first entry text'), { answer: '1' }, meta);
    clock.advance(1);
    cache.set(scope(), input('second entry text'), { answer: '2' }, meta);
    clock.advance(1);
    cache.get(scope(), input('first entry text'));
    clock.advance(1);
    cache.set(scope(), input('third entry text'), { answer: '3' }, meta);
    expect(cache.get(scope(), input('second entry text'))).toBeNull();
    expect(cache.get(scope(), input('first entry text'))).not.toBeNull();
    expect(cache.stats().evictions).toBe(1);
  });

  it('is a no-op when disabled', () => {
    const { cache } = cacheOf({ enabled: false });
    cache.set(scope(), input('x y z'), { answer: 'x' }, meta);
    expect(cache.get(scope(), input('x y z'))).toBeNull();
    expect(cache.stats().size).toBe(0);
  });

  it('[FR-TK-02] near-matching never crosses the structure key, however similar the text', () => {
    const { cache } = cacheOf({ similarityThreshold: 0.5 });
    const text = 'customer reports intermittent teams sign in failures at two branch offices';
    cache.set(scope(), input(text, 'hash-a'), { answer: 'a' }, meta);
    expect(
      cache.get(scope({ structureKey: 't'.repeat(64) }), input(`${text} today`, 'hash-b')),
    ).toBeNull();
    expect(cache.get(scope(), input(`${text} today`, 'hash-b'))?.kind).toBe('near');
  });

  it('[FR-TK-02] frees a bucket as soon as its last entry is gone (eviction, expiry, invalidation)', () => {
    const { cache, clock } = cacheOf({ ttlSeconds: 60, maxEntries: 2 });
    cache.set(scope({ caseId: 'case_a' }), input('alpha entry text'), { answer: 'a' }, meta);
    clock.advance(1);
    cache.set(scope({ caseId: 'case_b' }), input('bravo entry text'), { answer: 'b' }, meta);
    expect(cache.bucketCount()).toBe(2);

    clock.advance(1);
    cache.set(scope({ caseId: 'case_c' }), input('charlie entry text'), { answer: 'c' }, meta);
    expect(cache.stats()).toMatchObject({ size: 2, evictions: 1 });
    expect(cache.bucketCount()).toBe(2);

    clock.advance(70_000);
    expect(cache.get(scope({ caseId: 'case_b' }), input('bravo entry text'))).toBeNull();
    expect(cache.stats()).toMatchObject({ expirations: 1, size: 1 });
    expect(cache.bucketCount()).toBe(1);

    expect(cache.invalidate({ caseId: 'case_c' })).toBe(1);
    expect(cache.bucketCount()).toBe(0);
    expect(cache.stats().size).toBe(0);
  });

  it('[FR-TK-02] keeps an exact size when an entry is replaced, expired or removed', () => {
    const { cache, clock } = cacheOf({ ttlSeconds: 60 });
    cache.set(scope(), input('same entry text', 'h1'), { answer: '1' }, meta);
    cache.set(scope(), input('same entry text', 'h1'), { answer: '2' }, meta);
    expect(cache.stats().size).toBe(1);
    expect(cache.get(scope(), input('same entry text', 'h1'))?.value).toEqual({ answer: '2' });
    cache.set(scope(), input('another entry text', 'h2'), { answer: '3' }, meta);
    expect(cache.stats().size).toBe(2);
    clock.advance(61_000);
    expect(cache.get(scope(), input('same entry text', 'h1'))).toBeNull();
    expect(cache.stats()).toMatchObject({ size: 0, expirations: 2 });
    expect(cache.bucketCount()).toBe(0);
  });

  it('[FR-TK-02] does a constant amount of work per insert and keeps one bucket per live entry, however many scopes pass through', () => {
    const inserts = 2_000;
    const capacity = 100;
    const { cache } = cacheOf({ maxEntries: capacity });
    const { visits } = countMapIteration(() => {
      for (let i = 0; i < inserts; i++) {
        cache.set(
          scope({ caseId: `case_${i}` }),
          input(`entry number ${i} with a few more words`),
          { answer: String(i) },
          meta,
        );
      }
    });
    expect(cache.stats()).toMatchObject({ size: capacity, evictions: inserts - capacity });
    expect(cache.bucketCount()).toBe(capacity);
    // Elements read out of Map iterators, not time: linear in the inserts (the former implementation
    // rescanned every bucket it had ever created on every insert, millions of reads for this loop).
    expect(visits).toBeLessThanOrEqual(inserts * 10);
  });
});
