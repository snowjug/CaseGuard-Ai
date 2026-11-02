/**
 * Plain-language helpers for the guided review: how long something took, in words, and small text utilities. Pure, so
 * every sentence the review writes about time can be unit-tested.
 */

/** `1 event`, `2 events`. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** `a`, `a and b`, `a, b and c`. */
export function joinWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

/**
 * A span of minutes in words, with the two most significant units: `2 days 3 hours`, `15 hours 10 minutes`,
 * `45 minutes`. Rounded to the whole minute; anything under half a minute is `under a minute`.
 */
export function describeSpan(totalMinutes: number): string {
  if (!Number.isFinite(totalMinutes)) return 'an unknown time';
  const minutes = Math.round(Math.abs(totalMinutes));
  if (minutes < 1) return 'under a minute';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0)
    return hours > 0 ? `${plural(days, 'day')} ${plural(hours, 'hour')}` : plural(days, 'day');
  if (hours > 0)
    return mins > 0 ? `${plural(hours, 'hour')} ${plural(mins, 'minute')}` : plural(hours, 'hour');
  return plural(mins, 'minute');
}

/** Shortens `text` at a word boundary to at most `max` characters, adding `…` when something was cut. */
export function clipWords(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

/** Capitalises the first letter, leaving the rest of the text alone. */
export function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export interface RangeLike {
  low: number;
  mid: number;
  high: number;
}

/**
 * An estimate with its range in words: `4 h (2 h to 8 h)`. A range that is a single value (a recorded figure, not an
 * estimate) is shown as that value alone.
 */
export function describeRange(range: RangeLike, format: (value: number) => string): string {
  const mid = format(range.mid);
  if (range.low === range.high) return mid;
  return `${mid} (${format(range.low)} to ${format(range.high)})`;
}
