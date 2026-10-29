import type { Sleep } from '../types';

export interface Deadline {
  readonly signal: AbortSignal;
  /** True when the deadline (not the caller) aborted the signal. */
  timedOut(): boolean;
  /** True when the caller's signal aborted. */
  cancelled(): boolean;
  dispose(): void;
}

/** Combines a total timeout with an optional caller signal into one abortable signal. */
export function createDeadline(timeoutMs: number, parent?: AbortSignal): Deadline {
  const controller = new AbortController();
  let timedOut = false;
  let cancelled = false;
  const onParentAbort = (): void => {
    cancelled = true;
    controller.abort(parent?.reason);
  };
  if (parent?.aborted) onParentAbort();
  else parent?.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('deadline exceeded'));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut && !cancelled,
    cancelled: () => cancelled,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}

/** Sleep that rejects as soon as the signal aborts. */
export const abortableSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
