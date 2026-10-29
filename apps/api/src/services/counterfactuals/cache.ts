interface Entry<V> {
  readonly value: V;
  readonly expiresAt: number;
}

/**
 * A small bounded cache: the least recently used entry is evicted first and an entry expires after
 * `ttlMs`. Time is passed in by the caller (always `ctx.now()`), never read from the system clock.
 * Keys must carry everything the value depends on (tenant, case, run, version), so a hit is always
 * exactly what a recomputation would produce.
 */
export class LruCache<V> {
  private readonly entries = new Map<string, Entry<V>>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number = Number.POSITIVE_INFINITY,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('A cache needs room for at least one entry');
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string, nowMs: number): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= nowMs) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-insert so the entry becomes the most recently used one.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, nowMs: number): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: nowMs + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  /** Returns the cached value, or computes, stores and returns it. */
  async getOrCompute(key: string, nowMs: number, compute: () => Promise<V> | V): Promise<V> {
    const cached = this.get(key, nowMs);
    if (cached !== undefined) return cached;
    const value = await compute();
    this.set(key, value, nowMs);
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}
