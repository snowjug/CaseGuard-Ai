import { NotImplementedError } from '../errors';

/**
 * A port whose implementation is not wired in yet: every method rejects with a 501 problem instead of
 * failing obscurely. Used only while the build is incomplete; the completeness test fails if a
 * documented route still depends on one.
 */
export function unavailable<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get(_target, property) {
      // `await port` and Promise adoption probe `then`; symbols are used by inspection helpers.
      if (typeof property === 'symbol' || property === 'then') return undefined;
      return () => Promise.reject(new NotImplementedError(`${name}.${property}`));
    },
  });
}
