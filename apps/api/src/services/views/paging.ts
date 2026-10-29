/** One page of an ordered in-memory list plus the opaque cursor of its last item (null at the end). */
export interface MemoryPage<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

/**
 * Keyset pagination over an already sorted list: the page starts at the first item for which
 * `isAfterCursor` holds (everything when there is no cursor) and holds at most `limit` items.
 */
export function pageAfter<T>(
  items: readonly T[],
  options: {
    readonly limit: number;
    readonly hasCursor: boolean;
    readonly isAfterCursor: (item: T) => boolean;
    readonly cursorOf: (item: T) => string;
  },
): MemoryPage<T> {
  const start = options.hasCursor ? items.findIndex(options.isAfterCursor) : 0;
  const rest = start < 0 ? [] : items.slice(start);
  const page = rest.slice(0, options.limit);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: rest.length > options.limit && last !== undefined ? options.cursorOf(last) : null,
  };
}

/** Distinct values in first-seen order. */
export function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
