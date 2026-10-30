import { vi } from 'vitest';

type Report = (entries: { isIntersecting: boolean; target: Element }[]) => void;

export interface NearEndObserver {
  /** How many observers the page has created (a rebuilt observer reports again at once, as a real one does). */
  created: () => number;
}

/**
 * Replaces `IntersectionObserver` with one that reports the way a real one does in the one respect that matters for
 * infinite scrolling: it reports the element's state as soon as it starts to observe it (here: always in view), and
 * never after it was disconnected. Remove it with `vi.unstubAllGlobals()`.
 */
export function installNearEndObserver(): NearEndObserver {
  let created = 0;
  class FakeObserver {
    private disconnected = false;
    constructor(private readonly report: Report) {
      created += 1;
    }
    observe(target: Element): void {
      queueMicrotask(() => {
        if (!this.disconnected) this.report([{ isIntersecting: true, target }]);
      });
    }
    unobserve(): void {
      // One element is observed per observer here.
    }
    disconnect(): void {
      this.disconnected = true;
    }
    takeRecords(): [] {
      return [];
    }
  }
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  return { created: () => created };
}
