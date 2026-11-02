import type { Permission } from '@caseguard/schemas';

/**
 * What one read of the guided review is, from the point of view of the part of the page that shows it. A part never
 * fails the whole page: it is still loading, the role may not read it (no request was made), the read failed, or it is
 * there. The pure derivations only ever see the `ready` data.
 */
export type Source<T> =
  | { kind: 'loading' }
  | { kind: 'denied'; permission: Permission }
  | { kind: 'failed'; error: unknown }
  | { kind: 'ready'; data: T };

export const loading = <T>(): Source<T> => ({ kind: 'loading' });
export const denied = <T>(permission: Permission): Source<T> => ({ kind: 'denied', permission });
export const failed = <T>(error: unknown): Source<T> => ({ kind: 'failed', error });
export const ready = <T>(data: T): Source<T> => ({ kind: 'ready', data });

/** The data of a source that is ready, otherwise `null`. */
export function dataOf<T>(source: Source<T>): T | null {
  return source.kind === 'ready' ? source.data : null;
}

/** Maps a ready source, passing the other states through. */
export function mapSource<T, U>(source: Source<T>, map: (data: T) => U): Source<U> {
  return source.kind === 'ready' ? ready(map(source.data)) : source;
}

/** A source that is not (yet) usable. */
export type Blocked = Exclude<Source<unknown>, { kind: 'ready' }>;

/** The first source that is not ready, as the state a part built from several reads is in; `null` when all are. */
export function blockedBy(sources: readonly Source<unknown>[]): Blocked | null {
  for (const source of sources) {
    if (source.kind === 'denied') return source;
  }
  for (const source of sources) {
    if (source.kind === 'failed') return source;
  }
  for (const source of sources) {
    if (source.kind === 'loading') return source;
  }
  return null;
}

/** The permissions a person lacks for the sources that were denied, without repeats. */
export function missingPermissions(sources: readonly Source<unknown>[]): Permission[] {
  const missing = new Set<Permission>();
  for (const source of sources) if (source.kind === 'denied') missing.add(source.permission);
  return [...missing];
}
