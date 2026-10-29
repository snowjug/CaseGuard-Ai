import type { ResolvedOptions } from './options';
import { sourceList } from './draft-meta';
import { displayValue, type WarningCollector } from './text';
import {
  addDays,
  inferDateOrder,
  isoDate,
  resolveDateOnly,
  resolveMoment,
  type CalendarDate,
} from './timestamps';
import type { Item, RawTurn } from './transcript-lines';
import type { TimestampBasis } from './types';

export interface TurnTime {
  ms: number;
  basis: TimestampBasis;
  zoneAssumed: boolean;
}

const HALF_DAY_MS = 12 * 3_600_000;

interface Tracked {
  date: CalendarDate;
  /** The date did not come from the text (default date or clock). */
  assumed: boolean;
}

const isTurn = (item: Item): item is RawTurn => item.kind !== 'date';

/**
 * Resolves the stamp of every turn to UTC milliseconds, one entry per turn in source order
 * (`null` where none could be read). Time-only stamps take their date from the nearest date line
 * or stamp before them, else from `defaultDate`, else from the injected clock, and say so.
 */
export function resolveTurnTimes(
  items: readonly Item[],
  options: ResolvedOptions,
  warnings: WarningCollector,
): (TurnTime | null)[] {
  const turns = items.filter(isTurn);
  const out: (TurnTime | null)[] = new Array<TurnTime | null>(turns.length).fill(null);
  const ambiguous = items.flatMap((item) => {
    const a = item.kind === 'date' ? item.scanned.ambiguous : (item.scanned?.ambiguous ?? null);
    return a ? [a] : [];
  });
  const order = options.dateOrder ?? inferDateOrder(ambiguous);

  let tracked: Tracked | null = null;
  let previousMs: number | null = null;
  let assumedDateWarned = false;
  const failures: { line: number; text: string }[] = [];
  const zones = new Map<string, number>();

  for (const item of items) {
    if (item.kind === 'date') {
      const date = resolveDateOnly(item.scanned, order);
      if (date) tracked = { date, assumed: false };
      else failures.push({ line: item.line, text: 'the date is ambiguous or not a real date' });
      continue;
    }
    const scanned = item.scanned;
    if (!scanned?.time) {
      if (item.unparsedStamp !== null) {
        failures.push({
          line: item.line,
          text: `"${displayValue(item.unparsedStamp, 40)}" is not a recognised date and time`,
        });
      }
      continue;
    }
    if (scanned.unrecognisedZone) {
      zones.set(scanned.unrecognisedZone, (zones.get(scanned.unrecognisedZone) ?? 0) + 1);
    }
    const written = scanned.date !== null || scanned.ambiguous !== null;
    let context = tracked;
    if (!written && !context) {
      const fallback = options.defaultDate ?? isoDate(options.nowMs);
      context = { date: fallback, assumed: true };
      if (!assumedDateWarned) {
        assumedDateWarned = true;
        warnings.add(
          'date_assumed',
          options.defaultDate ? 'info' : 'warning',
          options.defaultDate
            ? `Some stamps carry only a time of day; the date ${fmt(fallback)} (defaultDate) was used.`
            : `Some stamps carry only a time of day and no date was supplied; ${fmt(fallback)} from the ingestion clock was used.`,
          { hint: 'Add a date line such as "2026-03-09" or pass defaultDate.', line: item.line },
        );
      }
    }
    const resolved = resolveMoment(scanned, {
      currentDate: context?.date ?? null,
      assumedOffsetMinutes: options.assumedOffsetMinutes,
      dateOrder: order,
    });
    if (!resolved.ok) {
      failures.push({ line: item.line, text: resolved.detail });
      continue;
    }
    let { ms } = resolved.value;
    let basis: TimestampBasis = item.kind === 'email' ? 'header' : 'explicit';
    let date = resolved.value.date;
    if (!written) {
      if (context?.assumed) basis = 'date_assumed';
      if (previousMs !== null && ms < previousMs && previousMs - ms >= HALF_DAY_MS) {
        ms += 24 * 3_600_000;
        date = addDays(date, 1);
        basis = 'rollover';
      }
    }
    tracked = { date, assumed: !written && (context?.assumed ?? false) };
    previousMs = ms;
    out[item.index] = { ms, basis, zoneAssumed: resolved.value.assumedZone };
  }

  if (failures.length > 0) {
    const sample = failures
      .slice(0, 3)
      .map((f) => `line ${f.line}: ${f.text}`)
      .join('; ');
    warnings.add(
      'timestamp_unresolved',
      'warning',
      `${failures.length} timestamp(s) could not be read (${sample}${failures.length > 3 ? '; …' : ''}).`,
      {
        hint: `Use ISO dates such as 2026-03-09 09:12 UTC. Affected: ${sourceList(failures.map((f) => f.line))}.`,
        count: failures.length,
        line: failures[0]?.line,
      },
    );
  }
  for (const [zone, count] of zones) {
    warnings.add(
      'timezone_unrecognised',
      'warning',
      `The time zone "${zone}" is ambiguous and was not interpreted (${count} timestamp(s)); the assumed offset was used instead.`,
      { hint: 'Write the offset instead, for example +02:00 or -05:00.', count },
    );
  }
  return out;
}

const fmt = (d: CalendarDate): string =>
  `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;

/**
 * Gives every turn a time: unstamped turns inherit from the previous stamped one (or, at the
 * start, the first stamped one). Returns `null` when nothing in the text had a usable stamp.
 */
export function fillTurnTimes(times: readonly (TurnTime | null)[]): TurnTime[] | null {
  const firstKnown = times.find((t): t is TurnTime => t !== null);
  if (!firstKnown) return null;
  let carry: number = firstKnown.ms;
  return times.map((t) => {
    if (t) {
      carry = t.ms;
      return t;
    }
    return { ms: carry, basis: 'inherited', zoneAssumed: false };
  });
}
