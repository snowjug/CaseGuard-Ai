type MapIteration = (this: Map<unknown, unknown>) => IterableIterator<unknown>;

const ITERATION_METHODS = ['entries', 'keys', 'values', Symbol.iterator] as const;

/**
 * Counts the elements that `run` pulls out of Map iterators. It measures how much scanning a piece
 * of synchronous code does, independently of how fast or busy the machine is, so a test can assert
 * a work bound instead of a wall-clock time.
 */
export function countMapIteration<T>(run: () => T): { result: T; visits: number } {
  const proto = Map.prototype as unknown as Record<PropertyKey, MapIteration | undefined>;
  const originals = ITERATION_METHODS.map((name) => proto[name]);
  let visits = 0;
  ITERATION_METHODS.forEach((name, i) => {
    const original = originals[i];
    if (original === undefined) return;
    proto[name] = function counting(this: Map<unknown, unknown>) {
      const inner = original.call(this);
      const wrapped: IterableIterator<unknown> = {
        next: () => {
          const step = inner.next();
          if (step.done !== true) visits++;
          return step;
        },
        [Symbol.iterator]: () => wrapped,
      };
      return wrapped;
    };
  });
  try {
    return { result: run(), visits };
  } finally {
    ITERATION_METHODS.forEach((name, i) => {
      proto[name] = originals[i];
    });
  }
}
