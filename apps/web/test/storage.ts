type StorageName = 'localStorage' | 'sessionStorage';

function createMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(String(key)) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(String(key));
    },
    setItem: (key, value) => {
      data.set(String(key), String(value));
    },
  };
}

function isWorking(name: StorageName): boolean {
  try {
    const storage: Storage | undefined = globalThis[name];
    return typeof storage?.clear === 'function';
  } catch {
    return false;
  }
}

/**
 * Node 25+ defines a global `localStorage` that is `undefined` (plus a warning) unless `--localstorage-file` is set, and
 * it shadows jsdom's implementation. Installing an in-memory Storage when the global is unusable keeps the tests
 * identical on every supported Node version (the repository requires Node 24 or newer).
 */
export function installWebStorage(): void {
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    if (isWorking(name)) continue;
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: createMemoryStorage(),
    });
  }
}
