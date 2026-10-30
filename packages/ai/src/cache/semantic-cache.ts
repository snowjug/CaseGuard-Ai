import type { AgentName, ProviderKind } from '@caseguard/schemas';
import { noopMetrics, type Clock, type Metrics, type ModelUsage } from '../types';
import { contentWords, jaccard } from '../util/text';

/**
 * Everything that must match for a cached answer to be reusable. Tenant and case are part of the
 * key, so an entry can never be served to another tenant or case; the boundary key keeps an answer
 * computed with more information from being reused for an earlier point in time; the structure key
 * keeps a proposal written for one request (strategy, fork, scenario, claim subset...) from being
 * served to another.
 */
export interface CacheScope {
  tenantId: string;
  caseId: string | null;
  agent: AgentName;
  /** Template hash of the prompt version used. */
  promptHash: string;
  packVersion: string;
  /** `${mode}:${asOf}:${fingerprint}` of the temporal view, plus the routed model. */
  boundaryKey: string;
  /** Hash of everything in the context except the prose of events (see `contextStructureKey`). */
  structureKey: string;
}

export interface CacheInput {
  /** Hash of the normalised input (exact-match key). */
  hash: string;
  /** Normalised prose (event text) used for lexical near-match; never ids, focus or knowledge. */
  text: string;
}

export interface CacheEntryMeta {
  provider: ProviderKind;
  model: string;
  usage: ModelUsage;
}

export interface CacheHit<T> {
  kind: 'exact' | 'near';
  similarity: number;
  value: T;
  meta: CacheEntryMeta;
}

export interface CacheStats {
  hits: number;
  exactHits: number;
  nearHits: number;
  misses: number;
  expirations: number;
  evictions: number;
  size: number;
}

export interface SemanticCacheOptions {
  clock: Clock;
  enabled: boolean;
  ttlSeconds: number;
  /** Jaccard similarity of content words at or above which a near-match is served; 1 = exact only. */
  similarityThreshold: number;
  maxEntries?: number;
  metrics?: Metrics;
}

export interface InvalidationFilter {
  tenantId?: string;
  caseId?: string;
  agent?: AgentName;
  promptHash?: string;
  packVersion?: string;
}

interface Stored<T> {
  scope: CacheScope;
  hash: string;
  words: Set<string>;
  value: T;
  meta: CacheEntryMeta;
  expiresAtMs: number;
}

const scopeKey = (s: CacheScope): string =>
  [
    s.tenantId,
    s.caseId ?? '-',
    s.agent,
    s.promptHash,
    s.packVersion,
    s.boundaryKey,
    s.structureKey,
  ].join('\u0000');

const entryId = (bucketKey: string, hash: string): string => `${bucketKey}\u0001${hash}`;

/**
 * Tenant-scoped, TTL-bound semantic cache with exact and lexical near-match lookup. Near-matching
 * only ever compares entries of the same bucket, i.e. requests that agree on everything but prose.
 * Upkeep is constant time per operation: a running entry count, an LRU order kept by the insertion
 * order of a map, and buckets that are deleted the moment they empty.
 */
export class SemanticCache<T = unknown> {
  private readonly buckets = new Map<string, Map<string, Stored<T>>>();
  /** Entries from least to most recently used. */
  private readonly recency = new Map<string, { bucketKey: string; hash: string }>();
  private entries = 0;
  private readonly counters = {
    hits: 0,
    exactHits: 0,
    nearHits: 0,
    misses: 0,
    expirations: 0,
    evictions: 0,
  };
  private readonly maxEntries: number;
  private readonly metrics: Metrics;

  constructor(private readonly options: SemanticCacheOptions) {
    this.maxEntries = options.maxEntries ?? 500;
    this.metrics = options.metrics ?? noopMetrics;
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  /** Number of buckets currently held (diagnostics: never more than the number of entries). */
  bucketCount(): number {
    return this.buckets.size;
  }

  private miss(agent: AgentName): null {
    this.counters.misses++;
    this.metrics.increment('ai.cache.miss', 1, { agent });
    return null;
  }

  private touch(bucketKey: string, hash: string): void {
    const id = entryId(bucketKey, hash);
    this.recency.delete(id);
    this.recency.set(id, { bucketKey, hash });
  }

  /** Removes one entry, and its bucket when that was the last one. */
  private drop(bucketKey: string, bucket: Map<string, Stored<T>>, hash: string): void {
    if (!bucket.delete(hash)) return;
    this.entries--;
    this.recency.delete(entryId(bucketKey, hash));
    if (bucket.size === 0) this.buckets.delete(bucketKey);
  }

  /** Returns a cached, previously validated value or null. Expired entries are dropped on sight. */
  get(scope: CacheScope, input: CacheInput): CacheHit<T> | null {
    if (!this.options.enabled) return null;
    const now = this.options.clock.nowMs();
    const key = scopeKey(scope);
    const bucket = this.buckets.get(key);
    if (!bucket) return this.miss(scope.agent);
    for (const [hash, stored] of bucket) {
      if (stored.expiresAtMs <= now) {
        this.drop(key, bucket, hash);
        this.counters.expirations++;
      }
    }
    const exact = bucket.get(input.hash);
    let chosen: { stored: Stored<T>; kind: 'exact' | 'near'; similarity: number } | null = exact
      ? { stored: exact, kind: 'exact', similarity: 1 }
      : null;
    if (!chosen && this.options.similarityThreshold < 1) {
      const words = new Set(contentWords(input.text));
      for (const stored of bucket.values()) {
        const similarity = jaccard(words, stored.words);
        if (
          similarity >= this.options.similarityThreshold &&
          similarity > (chosen?.similarity ?? 0)
        ) {
          chosen = { stored, kind: 'near', similarity };
        }
      }
    }
    if (!chosen) return this.miss(scope.agent);
    this.touch(key, chosen.stored.hash);
    this.counters.hits++;
    if (chosen.kind === 'exact') this.counters.exactHits++;
    else this.counters.nearHits++;
    this.metrics.increment('ai.cache.hit', 1, { agent: scope.agent, kind: chosen.kind });
    return {
      kind: chosen.kind,
      similarity: chosen.similarity,
      value: structuredClone(chosen.stored.value),
      meta: chosen.stored.meta,
    };
  }

  /** Stores a validated value. Callers must never store rejected or fallback output. */
  set(scope: CacheScope, input: CacheInput, value: T, meta: CacheEntryMeta): void {
    if (!this.options.enabled) return;
    const now = this.options.clock.nowMs();
    const key = scopeKey(scope);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new Map<string, Stored<T>>();
      this.buckets.set(key, bucket);
    }
    if (!bucket.has(input.hash)) this.entries++;
    bucket.set(input.hash, {
      scope,
      hash: input.hash,
      words: new Set(contentWords(input.text)),
      value: structuredClone(value),
      meta,
      expiresAtMs: now + this.options.ttlSeconds * 1000,
    });
    this.touch(key, input.hash);
    while (this.entries > this.maxEntries) {
      if (!this.evictOldest()) break;
    }
  }

  /** Drops the least recently used entry; false when there is nothing to drop. */
  private evictOldest(): boolean {
    const oldest = this.recency.values().next();
    if (oldest.done) return false;
    const { bucketKey, hash } = oldest.value;
    const bucket = this.buckets.get(bucketKey);
    if (bucket) this.drop(bucketKey, bucket, hash);
    else this.recency.delete(entryId(bucketKey, hash));
    this.counters.evictions++;
    return true;
  }

  /** Drops entries matching every given field; returns how many were removed. */
  invalidate(filter: InvalidationFilter): number {
    return this.removeWhere(
      (s) =>
        (filter.tenantId === undefined || s.scope.tenantId === filter.tenantId) &&
        (filter.caseId === undefined || s.scope.caseId === filter.caseId) &&
        (filter.agent === undefined || s.scope.agent === filter.agent) &&
        (filter.promptHash === undefined || s.scope.promptHash === filter.promptHash) &&
        (filter.packVersion === undefined || s.scope.packVersion === filter.packVersion),
    );
  }

  clearTenant(tenantId: string): number {
    return this.invalidate({ tenantId });
  }

  /**
   * Explicit invalidation when the knowledge pack or a prompt version changes: keys already embed
   * both, so stale entries cannot be hit; this frees them and makes the change auditable.
   */
  purgeStale(current: {
    promptHashes: ReadonlySet<string>;
    packVersions: ReadonlySet<string>;
  }): number {
    return this.removeWhere(
      (s) =>
        !current.promptHashes.has(s.scope.promptHash) ||
        !current.packVersions.has(s.scope.packVersion),
    );
  }

  private removeWhere(predicate: (stored: Stored<T>) => boolean): number {
    let removed = 0;
    for (const [bucketKey, bucket] of this.buckets) {
      for (const [hash, stored] of bucket) {
        if (predicate(stored)) {
          this.drop(bucketKey, bucket, hash);
          removed++;
        }
      }
    }
    return removed;
  }

  stats(): CacheStats {
    return { ...this.counters, size: this.entries };
  }
}
