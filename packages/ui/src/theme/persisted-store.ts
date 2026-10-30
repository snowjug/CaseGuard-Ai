/** A tiny external store: works with `useSyncExternalStore` and keeps no hidden global state. */
export interface PersistedStore<T> {
  get: () => T;
  set: (value: T) => void;
  subscribe: (listener: () => void) => () => void;
}

export interface PersistedStoreOptions<T> {
  /** localStorage key. */
  key: string;
  /** Turns the raw stored string (or null) into a valid value; must never throw. */
  parse(raw: string | null): T;
  /** Returns the string to persist, or null to remove the key. */
  serialize(value: T): string | null;
  /** Override for tests or for sessionStorage. */
  getStorage?: () => Storage | undefined;
}

function defaultStorage(): Storage | undefined {
  return typeof window === 'undefined' ? undefined : window.localStorage;
}

/**
 * Creates a store backed by web storage. If storage is unavailable (private mode, blocked cookies) the value is
 * kept in memory for the page lifetime, so the preference still works within the session.
 */
export function createPersistedStore<T>(options: PersistedStoreOptions<T>): PersistedStore<T> {
  const listeners = new Set<() => void>();
  const resolveStorage = options.getStorage ?? defaultStorage;
  let memory: { value: T } | null = null;

  const safeStorage = (): Storage | undefined => {
    try {
      return resolveStorage();
    } catch (error) {
      // Accessing storage can throw (SecurityError); fall back to memory below.
      console.warn(`Storage unavailable for "${options.key}"; using in-memory value`, error);
      return undefined;
    }
  };

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  return {
    get() {
      if (memory) return memory.value;
      const storage = safeStorage();
      if (!storage) return options.parse(null);
      try {
        return options.parse(storage.getItem(options.key));
      } catch (error) {
        console.warn(`Could not read "${options.key}" from storage`, error);
        return options.parse(null);
      }
    },
    set(value) {
      const storage = safeStorage();
      const raw = options.serialize(value);
      try {
        if (storage) {
          if (raw === null) storage.removeItem(options.key);
          else storage.setItem(options.key, raw);
          memory = null;
        } else {
          memory = { value };
        }
      } catch (error) {
        console.warn(`Could not persist "${options.key}"; keeping it in memory`, error);
        memory = { value };
      }
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      const onStorage = (event: StorageEvent): void => {
        if (event.key === null || event.key === options.key) listener();
      };
      if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
      return () => {
        listeners.delete(listener);
        if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
      };
    },
  };
}
