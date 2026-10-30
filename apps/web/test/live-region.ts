/** The live region (status, alert, log or `aria-live`) an element sits in, or `null` when it is in none. */
export function liveRegionOf(element: Element): HTMLElement | null {
  return element.closest<HTMLElement>(
    '[role="status"], [role="alert"], [role="log"], [aria-live="polite"], [aria-live="assertive"]',
  );
}

export interface ChangeWatch {
  /** How many changes (text, children, attributes) were made inside the element since the watch began. */
  count: () => number;
  stop: () => void;
}

/**
 * Counts what changes inside an element from now on. A live region that changes once a second is read out once a
 * second, so a test can hold a countdown to a handful of changes instead of one per tick.
 */
export function watchChanges(element: Element): ChangeWatch {
  let changes = 0;
  const observer = new MutationObserver((records) => {
    changes += records.length;
  });
  observer.observe(element, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
  return {
    count: () => {
      changes += observer.takeRecords().length;
      return changes;
    },
    stop: () => observer.disconnect(),
  };
}
