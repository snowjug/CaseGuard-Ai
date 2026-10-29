import type { LabelValue } from './types';

/** Label value that absorbs everything beyond a label's distinct-value budget. */
export const OVERFLOW_LABEL_VALUE = 'other';

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_LABEL_VALUE_LENGTH = 128;

export function assertMetricName(name: string): void {
  if (!METRIC_NAME.test(name)) {
    throw new TypeError(`Invalid metric name "${name}": expected [a-zA-Z_:][a-zA-Z0-9_:]*`);
  }
}

export function assertLabelNames(
  metric: string,
  names: readonly string[],
  reserved: readonly string[],
): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (!LABEL_NAME.test(name) || name.startsWith('__')) {
      throw new TypeError(`Invalid label name "${name}" on metric "${metric}"`);
    }
    if (reserved.includes(name)) {
      throw new TypeError(`Label name "${name}" is reserved on metric "${metric}"`);
    }
    if (seen.has(name)) throw new TypeError(`Duplicate label name "${name}" on metric "${metric}"`);
    seen.add(name);
  }
}

function coerce(value: LabelValue): string {
  const text = typeof value === 'string' ? value : String(value);
  return text.length > MAX_LABEL_VALUE_LENGTH ? text.slice(0, MAX_LABEL_VALUE_LENGTH) : text;
}

export interface LabelLimits {
  /** Distinct values allowed per label unless overridden. */
  readonly defaultMax: number;
  readonly overrides?: Readonly<Record<string, number | undefined>>;
}

/**
 * Cardinality guard for one metric: each label may take at most N distinct values (the first N seen);
 * every later new value is folded into `other` so a bug or an attacker cannot create unbounded series.
 */
export class LabelGuard {
  private readonly seen = new Map<string, Set<string>>();
  private overflowedSamples = 0;

  constructor(private readonly limits: LabelLimits) {}

  /** Number of label values replaced by `other` so far. */
  get overflowed(): number {
    return this.overflowedSamples;
  }

  normalize(labelName: string, raw: LabelValue | undefined): string {
    if (raw === undefined) return '';
    const value = coerce(raw);
    if (value === '' || value === OVERFLOW_LABEL_VALUE) return value;
    let values = this.seen.get(labelName);
    if (values === undefined) {
      values = new Set();
      this.seen.set(labelName, values);
    }
    if (values.has(value)) return value;
    if (values.size >= (this.limits.overrides?.[labelName] ?? this.limits.defaultMax)) {
      this.overflowedSamples += 1;
      return OVERFLOW_LABEL_VALUE;
    }
    values.add(value);
    return value;
  }

  /** Read-path normalisation: same result as `normalize` but never spends the distinct-value budget. */
  lookup(labelName: string, raw: LabelValue | undefined): string {
    if (raw === undefined) return '';
    const value = coerce(raw);
    if (value === '' || value === OVERFLOW_LABEL_VALUE) return value;
    const values = this.seen.get(labelName);
    if (values?.has(value) === true) return value;
    const limit = this.limits.overrides?.[labelName] ?? this.limits.defaultMax;
    return (values?.size ?? 0) >= limit ? OVERFLOW_LABEL_VALUE : value;
  }

  reset(): void {
    this.seen.clear();
    this.overflowedSamples = 0;
  }
}

/** Escapes a label value for the Prometheus text format: backslash, double quote and newline. */
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Escapes HELP text: backslash and newline (quotes are legal there). */
export function escapeHelp(help: string): string {
  return help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}
