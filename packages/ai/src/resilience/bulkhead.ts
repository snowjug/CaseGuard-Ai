import { ProviderError } from '../errors';

export interface BulkheadStats {
  name: string;
  active: number;
  queued: number;
  rejected: number;
  maxConcurrent: number;
  maxQueue: number;
}

export interface BulkheadOptions {
  name: string;
  maxConcurrent: number;
  /** Callers beyond `maxConcurrent` wait here; once the queue is full, calls are rejected. */
  maxQueue: number;
}

interface Waiter {
  grant: () => void;
}

/** Concurrency limit with a bounded wait queue so a slow provider cannot exhaust the process. */
export class Bulkhead {
  private active = 0;
  private rejected = 0;
  private readonly queue: Waiter[] = [];

  constructor(private readonly options: BulkheadOptions) {}

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(
        new ProviderError('cancelled', 'The request was cancelled before it started.'),
      );
    }
    if (this.active < this.options.maxConcurrent) {
      this.active++;
      return Promise.resolve();
    }
    if (this.queue.length >= this.options.maxQueue) {
      this.rejected++;
      return Promise.reject(
        new ProviderError(
          'overloaded',
          `Too many concurrent model requests (${this.options.name}); try again shortly.`,
        ),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          this.active++;
          resolve();
        },
      };
      const onAbort = (): void => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(
          new ProviderError('cancelled', 'The request was cancelled while waiting for capacity.'),
        );
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  private release(): void {
    this.active--;
    this.queue.shift()?.grant();
  }

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  stats(): BulkheadStats {
    return {
      name: this.options.name,
      active: this.active,
      queued: this.queue.length,
      rejected: this.rejected,
      maxConcurrent: this.options.maxConcurrent,
      maxQueue: this.options.maxQueue,
    };
  }
}
