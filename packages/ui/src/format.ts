/**
 * UTC-explicit formatting. Every timestamp in CaseGuard is stored and compared in UTC (assumption A-17), so the UI
 * always prints the time zone next to the time; it never silently converts to the viewer's locale.
 * Deterministic: no dependence on the runtime's ICU data for dates.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Shown wherever a value is absent or unparseable. */
export const NOT_AVAILABLE = '—';

export type DateInput = string | number | Date | null | undefined;

function toDate(input: DateInput): Date | null {
  if (input === null || input === undefined || input === '') return null;
  const date = input instanceof Date ? input : new Date(input);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `14 Mar 2025` (UTC date). */
export function formatDateUtc(input: DateInput): string {
  const d = toDate(input);
  if (!d) return NOT_AVAILABLE;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ''} ${d.getUTCFullYear()}`;
}

/** `09:42 UTC` (`09:42:07 UTC` with `seconds`). */
export function formatTimeUtc(input: DateInput, options: { seconds?: boolean } = {}): string {
  const d = toDate(input);
  if (!d) return NOT_AVAILABLE;
  const base = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  return `${options.seconds ? `${base}:${pad2(d.getUTCSeconds())}` : base} UTC`;
}

/** `14 Mar 2025, 09:42 UTC`. */
export function formatDateTimeUtc(input: DateInput, options: { seconds?: boolean } = {}): string {
  const d = toDate(input);
  if (!d) return NOT_AVAILABLE;
  return `${formatDateUtc(d)}, ${formatTimeUtc(d, options)}`;
}

/** Compact axis label: `14 Mar` (UTC), with the year when `withYear`. */
export function formatDayMonthUtc(input: DateInput, withYear = false): string {
  const d = toDate(input);
  if (!d) return NOT_AVAILABLE;
  const base = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ''}`;
  return withYear ? `${base} ${d.getUTCFullYear()}` : base;
}

/**
 * Human duration from minutes: `45 min`, `2 h 05 min`, `3 d 4 h`. Negative values keep their sign.
 * Only the two most significant units are shown so the text stays short.
 */
export function formatDuration(totalMinutes: number | null | undefined): string {
  if (totalMinutes === null || totalMinutes === undefined || !Number.isFinite(totalMinutes)) {
    return NOT_AVAILABLE;
  }
  const sign = totalMinutes < 0 ? '-' : '';
  const minutes = Math.round(Math.abs(totalMinutes));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${sign}${days} d${hours > 0 ? ` ${hours} h` : ''}`;
  if (hours > 0) return `${sign}${hours} h${mins > 0 ? ` ${pad2(mins)} min` : ''}`;
  return `${sign}${mins} min`;
}

export interface NumberFormatOptions {
  maximumFractionDigits?: number;
  minimumFractionDigits?: number;
  /** Prefix `+` for positive numbers (deltas). */
  signed?: boolean;
}

/** Locale-stable (`en-US`) number formatting with thousands separators. */
export function formatNumber(
  value: number | null | undefined,
  options: NumberFormatOptions = {},
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NOT_AVAILABLE;
  const formatted = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: options.maximumFractionDigits ?? 1,
    minimumFractionDigits: options.minimumFractionDigits ?? 0,
  }).format(value);
  return options.signed && value > 0 ? `+${formatted}` : formatted;
}

/** Formats a probability in [0, 1] as a percentage: `0.624` becomes `62%`. */
export function formatProbability(value: number | null | undefined, fractionDigits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NOT_AVAILABLE;
  return `${formatNumber(value * 100, { maximumFractionDigits: fractionDigits, minimumFractionDigits: fractionDigits })}%`;
}

/** Formats a value that is already a percentage: `37.5` becomes `37.5%`. */
export function formatPercent(value: number | null | undefined, fractionDigits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NOT_AVAILABLE;
  return `${formatNumber(value, { maximumFractionDigits: fractionDigits, minimumFractionDigits: fractionDigits })}%`;
}

/** `12 min`, `3.2 h`: used for metric units coming from the API (`MetricUnit`). */
export function formatMetricValue(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NOT_AVAILABLE;
  switch (unit) {
    case 'percent':
      return formatPercent(value, 0);
    case 'minutes':
      return formatDuration(value);
    case 'hours':
      return `${formatNumber(value, { maximumFractionDigits: 1 })} h`;
    case 'bits_per_1k_tokens':
      return `${formatNumber(value, { maximumFractionDigits: 2 })} bits/1k tokens`;
    case 'ratio':
      return formatNumber(value, { maximumFractionDigits: 2 });
    default:
      return formatNumber(value, { maximumFractionDigits: 1 });
  }
}

/**
 * Relative time against an injected `now` (never reads the clock itself, so it is deterministic in tests).
 * Falls back to the absolute UTC time after 7 days.
 */
export function formatRelativeTime(input: DateInput, now: Date): string {
  const d = toDate(input);
  if (!d) return NOT_AVAILABLE;
  const diffMinutes = Math.round((now.getTime() - d.getTime()) / 60_000);
  const abs = Math.abs(diffMinutes);
  if (abs >= 7 * 1440) return formatDateTimeUtc(d);
  if (abs < 1) return 'just now';
  const text = formatDuration(abs);
  return diffMinutes > 0 ? `${text} ago` : `in ${text}`;
}
