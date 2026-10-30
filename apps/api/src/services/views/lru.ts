/** An optional size bound for an LRU cache, on top of its entry count. */
export interface LruWeights<V> {
  /** Estimated size the cache may hold in total. The newest entry always stays, even alone above it. */
  readonly maxWeight: number;
  /** Estimated size of one value (a unit of your choosing, for example bytes). */
  readonly weigh: (value: V) => number;
}

interface Slot<V> {
  readonly value: V;
  readonly weight: number;
}

/**
 * A least-recently-used map bounded by entry count and, optionally, by estimated size: reading
 * refreshes an entry, inserting evicts the stalest until both bounds hold again.
 */
export class LruCache<K, V> {
  private readonly slots = new Map<K, Slot<V>>();
  private held = 0;

  constructor(
    readonly capacity: number,
    private readonly weights?: LruWeights<V>,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('An LRU cache needs a capacity of at least 1');
    }
    if (weights !== undefined && !(weights.maxWeight > 0)) {
      throw new RangeError('An LRU cache needs a positive size bound');
    }
  }

  get size(): number {
    return this.slots.size;
  }

  /** Estimated size currently held (0 when the cache has no size bound). */
  get weight(): number {
    return this.held;
  }

  get(key: K): V | undefined {
    const slot = this.slots.get(key);
    if (slot === undefined) return undefined;
    this.slots.delete(key);
    this.slots.set(key, slot);
    return slot.value;
  }

  set(key: K, value: V): void {
    this.discard(key);
    const weight = this.weights?.weigh(value) ?? 0;
    this.slots.set(key, { value, weight });
    this.held += weight;
    // Map iteration follows insertion order, so the first keys are the least recently used.
    for (const oldest of this.slots.keys()) {
      if (this.slots.size <= 1 || !this.overBound()) break;
      this.discard(oldest);
    }
  }

  delete(key: K): void {
    this.discard(key);
  }

  clear(): void {
    this.slots.clear();
    this.held = 0;
  }

  private overBound(): boolean {
    return (
      this.slots.size > this.capacity ||
      (this.weights !== undefined && this.held > this.weights.maxWeight)
    );
  }

  private discard(key: K): void {
    const slot = this.slots.get(key);
    if (slot === undefined) return;
    this.held -= slot.weight;
    this.slots.delete(key);
  }
}
