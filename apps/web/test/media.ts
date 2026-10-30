import { vi } from 'vitest';

type Listener = (event: MediaQueryListEvent) => void;

/**
 * jsdom has no `matchMedia`. This installs a fake whose `matches` comes from `matches(query)`; tests call it again to
 * simulate a narrow viewport or `prefers-color-scheme`/`prefers-reduced-motion`.
 */
export function installMatchMedia(matches: (query: string) => boolean = () => false): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => {
      const listeners = new Set<Listener>();
      return {
        matches: matches(query),
        media: query,
        onchange: null,
        addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
        removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      } as unknown as MediaQueryList;
    },
  });
}
