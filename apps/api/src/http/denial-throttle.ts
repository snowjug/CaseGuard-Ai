interface Window {
  startedAt: number;
  suppressed: number;
}

export interface DenialVerdict {
  /** Append the audit event now. */
  readonly write: boolean;
  /** Refusals left out of the trail since the previous event for this key (reported on the next one). */
  readonly suppressed: number;
}

/**
 * Bounds how many "access denied" events one caller can append to the audit trail.
 *
 * Every refusal is still answered with 403, logged and counted. The durable, hash-chained trail takes
 * the first refusal per caller and route in each window and, with it, how many were left out, so a
 * low-privilege credential cannot grow the append-only log (or hold the per-tenant audit lock) at
 * request speed. Memory is bounded: the oldest windows are dropped first.
 */
export class DenialAuditThrottle {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number,
    private readonly maxKeys = 10_000,
  ) {}

  admit(key: string): DenialVerdict {
    const at = this.now();
    const current = this.windows.get(key);
    if (current !== undefined && at - current.startedAt < this.windowMs) {
      current.suppressed += 1;
      return { write: false, suppressed: 0 };
    }

    // A new window: report what the previous one suppressed, and move the key to the newest position.
    const suppressed = current?.suppressed ?? 0;
    this.windows.delete(key);
    this.windows.set(key, { startedAt: at, suppressed: 0 });
    while (this.windows.size > this.maxKeys) {
      const oldest = this.windows.keys().next();
      if (oldest.done) break;
      this.windows.delete(oldest.value);
    }
    return { write: true, suppressed };
  }
}
