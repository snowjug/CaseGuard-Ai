import { groupOf } from './text';
import type { DateOrder } from './types';

/** Stamps outside this range are far more likely to be typos than real cases. */
export const MIN_YEAR = 1970;
export const MAX_YEAR = 2100;

export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

export interface ScannedMoment {
  date: CalendarDate | null;
  /** Numeric `a/b/yyyy` whose day/month order the text itself does not reveal. */
  ambiguous: { first: number; second: number; year: number } | null;
  time: {
    hour: number;
    minute: number;
    second: number;
    millis: number;
    meridiem: 'am' | 'pm' | null;
  } | null;
  offsetMinutes: number | null;
  /** A zone abbreviation such as CST that is deliberately not interpreted (it is ambiguous). */
  unrecognisedZone: string | null;
  /** Characters consumed from the start of the scanned text. */
  length: number;
}

const MONTH = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)';
const MONTH_NUMBER: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

// Sticky patterns: each is anchored at an explicit offset and has no nested quantifiers.
const WEEKDAY = /(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/iy;
const ISO_DATE = /(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?!\d)/y;
const DAY_FIRST = new RegExp(
  `(\\d{1,2})(?:st|nd|rd|th)?[\\s.-]+${MONTH}[a-z]*\\.?,?[\\s.-]*(\\d{4})(?!\\d)`,
  'iy',
);
const MONTH_FIRST = new RegExp(
  `${MONTH}[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?!\\d)`,
  'iy',
);
const NUMERIC_DATE = /(\d{1,2})([./-])(\d{1,2})\2(\d{4})(?!\d)/y;
const DATE_TIME_SEPARATOR = /(?:t(?=\d)|,?\s+(?:at\s+)?)/iy;
const TIME = /(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(?:\s?([ap])\.?m\.?(?![a-z]))?/iy;
const ZONE_UTC_OFFSET = /\s?(?:utc|gmt)\s?([+-])(\d{1,2})(?::?(\d{2}))?(?!\d)/iy;
const ZONE_NAME = /\s?(z|utc|gmt)(?![a-z])/iy;
const ZONE_ATTACHED_OFFSET = /([+-])(\d{2})(?::?(\d{2}))?(?!\d)/y;
const ZONE_SPACED_OFFSET = /\s([+-])(\d{2}):?(\d{2})(?!\d)/y;
const ZONE_ABBREVIATION =
  /\s?(est|edt|cst|cdt|mst|mdt|pst|pdt|cet|cest|bst|ist|jst|eet|eest|wet|west|aest|aedt|acst|awst|nzst|nzdt|hst|akst|akdt|sgt|hkt|kst|pkt|msk)(?![a-z])/iy;

function at(re: RegExp, text: string, index: number): RegExpExecArray | null {
  re.lastIndex = index;
  return re.exec(text);
}

const num = (match: RegExpExecArray, index: number): number =>
  Number.parseInt(groupOf(match, index), 10);

function offsetFrom(sign: string, hours: number, minutes: number): number | null {
  if (hours > 14 || minutes > 59) return null;
  const total = hours * 60 + minutes;
  return sign === '-' ? -total : total;
}

interface DateScan {
  date: CalendarDate | null;
  ambiguous: ScannedMoment['ambiguous'];
  end: number;
}

function scanDate(text: string, start: number): DateScan | null {
  let m = at(ISO_DATE, text, start);
  if (m) {
    return {
      date: { year: num(m, 1), month: num(m, 3), day: num(m, 4) },
      ambiguous: null,
      end: start + m[0].length,
    };
  }
  m = at(DAY_FIRST, text, start);
  if (m) {
    const month = MONTH_NUMBER[groupOf(m, 2).toLowerCase()] ?? 0;
    return {
      date: { year: num(m, 3), month, day: num(m, 1) },
      ambiguous: null,
      end: start + m[0].length,
    };
  }
  m = at(MONTH_FIRST, text, start);
  if (m) {
    const month = MONTH_NUMBER[groupOf(m, 1).toLowerCase()] ?? 0;
    return {
      date: { year: num(m, 3), month, day: num(m, 2) },
      ambiguous: null,
      end: start + m[0].length,
    };
  }
  m = at(NUMERIC_DATE, text, start);
  if (m) {
    const first = num(m, 1);
    const second = num(m, 3);
    const year = num(m, 4);
    const end = start + m[0].length;
    // Dots are the European day-first convention; slashes and dashes are genuinely ambiguous.
    if (groupOf(m, 2) === '.')
      return { date: { year, month: second, day: first }, ambiguous: null, end };
    return { date: null, ambiguous: { first, second, year }, end };
  }
  return null;
}

interface ZoneScan {
  offsetMinutes: number | null;
  unrecognised: string | null;
  end: number;
}

function scanZone(text: string, start: number): ZoneScan {
  let m = at(ZONE_UTC_OFFSET, text, start);
  if (m) {
    const offset = offsetFrom(groupOf(m, 1), num(m, 2), m[3] === undefined ? 0 : num(m, 3));
    if (offset !== null)
      return { offsetMinutes: offset, unrecognised: null, end: start + m[0].length };
  }
  m = at(ZONE_NAME, text, start);
  if (m) return { offsetMinutes: 0, unrecognised: null, end: start + m[0].length };
  m = at(ZONE_ATTACHED_OFFSET, text, start) ?? at(ZONE_SPACED_OFFSET, text, start);
  if (m) {
    const offset = offsetFrom(groupOf(m, 1), num(m, 2), m[3] === undefined ? 0 : num(m, 3));
    if (offset !== null)
      return { offsetMinutes: offset, unrecognised: null, end: start + m[0].length };
  }
  m = at(ZONE_ABBREVIATION, text, start);
  if (m) {
    return {
      offsetMinutes: null,
      unrecognised: groupOf(m, 1).toUpperCase(),
      end: start + m[0].length,
    };
  }
  return { offsetMinutes: null, unrecognised: null, end: start };
}

/**
 * Reads a date and/or time at the start of `text`. Deliberately avoids `Date.parse`, whose
 * accepted grammar is implementation-defined. Component ranges are checked by `resolveMoment`.
 */
export function scanMoment(text: string): ScannedMoment | null {
  let pos = 0;
  const weekday = at(WEEKDAY, text, 0);
  if (weekday) pos = weekday[0].length;

  const date = scanDate(text, pos);
  if (weekday && !date) return null;
  if (date) pos = date.end;

  let timeStart = pos;
  if (date) {
    const sep = at(DATE_TIME_SEPARATOR, text, pos);
    if (!sep) return { ...emptyMoment(date), length: pos };
    timeStart = pos + sep[0].length;
  }
  const time = at(TIME, text, timeStart);
  if (!time) {
    if (!date) return null;
    return { ...emptyMoment(date), length: pos };
  }
  const end = timeStart + time[0].length;
  const zone = scanZone(text, end);
  const meridiem = time[5] === undefined ? null : time[5].toLowerCase() === 'a' ? 'am' : 'pm';
  return {
    date: date?.date ?? null,
    ambiguous: date?.ambiguous ?? null,
    time: {
      hour: num(time, 1),
      minute: num(time, 2),
      second: time[3] === undefined ? 0 : num(time, 3),
      millis: time[4] === undefined ? 0 : Number.parseInt(time[4].padEnd(3, '0').slice(0, 3), 10),
      meridiem,
    },
    offsetMinutes: zone.offsetMinutes,
    unrecognisedZone: zone.unrecognised,
    length: zone.end,
  };
}

function emptyMoment(date: DateScan): Omit<ScannedMoment, 'length'> {
  return {
    date: date.date,
    ambiguous: date.ambiguous,
    time: null,
    offsetMinutes: null,
    unrecognisedZone: null,
  };
}

export interface MomentContext {
  /** Date used for stamps that carry only a time of day. */
  currentDate: CalendarDate | null;
  assumedOffsetMinutes: number;
  dateOrder: DateOrder | null;
}

export type MomentFailure =
  'ambiguous_date' | 'invalid_date' | 'invalid_time' | 'out_of_range' | 'no_date' | 'no_time';

export interface ResolvedMoment {
  ms: number;
  /** The calendar date as written (local to the stamp's own zone). */
  date: CalendarDate;
  /** True when no zone was written and the assumed offset was applied. */
  assumedZone: boolean;
  /** True when the date was not written and came from the context. */
  assumedDate: boolean;
}

export type MomentResolution =
  { ok: true; value: ResolvedMoment } | { ok: false; reason: MomentFailure; detail: string };

/** Works out day/month order for `03/09/2026` from the value itself or the supplied order. */
function orderAmbiguous(
  a: { first: number; second: number; year: number },
  order: DateOrder | null,
): CalendarDate | null {
  if (a.first > 12 && a.second <= 12) return { year: a.year, month: a.second, day: a.first };
  if (a.second > 12 && a.first <= 12) return { year: a.year, month: a.first, day: a.second };
  if (a.first === a.second) return { year: a.year, month: a.first, day: a.second };
  if (order === 'dmy') return { year: a.year, month: a.second, day: a.first };
  if (order === 'mdy') return { year: a.year, month: a.first, day: a.second };
  return null;
}

export function isValidDate(date: CalendarDate): boolean {
  if (date.year < MIN_YEAR || date.year > MAX_YEAR) return false;
  if (date.month < 1 || date.month > 12 || date.day < 1) return false;
  const probe = new Date(Date.UTC(date.year, date.month - 1, date.day));
  return probe.getUTCMonth() === date.month - 1 && probe.getUTCDate() === date.day;
}

/** Reads the whole text's convention from values that cannot be anything else (13/03 or 03/13). */
export function inferDateOrder(
  samples: readonly { first: number; second: number }[],
): DateOrder | null {
  const dayFirst = samples.some((s) => s.first > 12 && s.second <= 12);
  const monthFirst = samples.some((s) => s.second > 12 && s.first <= 12);
  if (dayFirst === monthFirst) return null;
  return dayFirst ? 'dmy' : 'mdy';
}

/** The calendar date of a date-only value, or null when it is ambiguous or not a real date. */
export function resolveDateOnly(
  scanned: ScannedMoment,
  order: DateOrder | null,
): CalendarDate | null {
  const date =
    scanned.date ?? (scanned.ambiguous ? orderAmbiguous(scanned.ambiguous, order) : null);
  return date && isValidDate(date) ? date : null;
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
  return isoDate(Date.UTC(date.year, date.month - 1, date.day) + days * 86_400_000);
}

/** Combines a scanned moment with its context into UTC epoch milliseconds, or says exactly why not. */
export function resolveMoment(scanned: ScannedMoment, ctx: MomentContext): MomentResolution {
  let date = scanned.date;
  let assumedDate = false;
  if (!date && scanned.ambiguous) {
    date = orderAmbiguous(scanned.ambiguous, ctx.dateOrder);
    if (!date) {
      const { first, second, year } = scanned.ambiguous;
      return {
        ok: false,
        reason: 'ambiguous_date',
        detail: `${first}/${second}/${year} could be day/month or month/day`,
      };
    }
  }
  if (!date) {
    if (!ctx.currentDate) return { ok: false, reason: 'no_date', detail: 'no date is available' };
    date = ctx.currentDate;
    assumedDate = true;
  }
  if (!scanned.time) return { ok: false, reason: 'no_time', detail: 'no time of day was given' };

  if (date.year < MIN_YEAR || date.year > MAX_YEAR) {
    return {
      ok: false,
      reason: 'out_of_range',
      detail: `year ${date.year} is outside ${MIN_YEAR}-${MAX_YEAR}`,
    };
  }
  if (!isValidDate(date)) {
    return {
      ok: false,
      reason: 'invalid_date',
      detail: `${date.year}-${pad2(date.month)}-${pad2(date.day)} is not a calendar date`,
    };
  }
  let { hour } = scanned.time;
  const { minute, second, millis, meridiem } = scanned.time;
  if (meridiem) {
    if (hour < 1 || hour > 12) {
      return { ok: false, reason: 'invalid_time', detail: `hour ${hour} is not valid with AM/PM` };
    }
    hour = (hour % 12) + (meridiem === 'pm' ? 12 : 0);
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return {
      ok: false,
      reason: 'invalid_time',
      detail: `${pad2(hour)}:${pad2(minute)}:${pad2(second)} is not a valid time`,
    };
  }
  const assumedZone = scanned.offsetMinutes === null;
  const offset = scanned.offsetMinutes ?? ctx.assumedOffsetMinutes;
  const ms =
    Date.UTC(date.year, date.month - 1, date.day, hour, minute, second, millis) - offset * 60_000;
  return { ok: true, value: { ms, date, assumedZone, assumedDate } };
}

export const pad2 = (n: number): string => String(n).padStart(2, '0');

/** UTC ISO-8601 with a trailing Z; whole seconds omit the fraction like the sample bundles. */
export function formatIso(ms: number): string {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

export function isoDate(ms: number): CalendarDate {
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function isFiniteMs(ms: number): boolean {
  if (!Number.isFinite(ms)) return false;
  const year = new Date(ms).getUTCFullYear();
  return year >= MIN_YEAR && year <= MAX_YEAR;
}

/** Parses `YYYY-MM-DD` (and nothing else) for the `defaultDate` option. */
export function parseCalendarDate(text: string): CalendarDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const date = { year: num(m, 1), month: num(m, 2), day: num(m, 3) };
  return isValidDate(date) ? date : null;
}

const DECORATION = /^[\s\-=*#_~>[\](){}|]+|[\s\-=*#_~<[\](){}|:]+$/g;

/** Recognises a line that only announces a date ("=== Tuesday, 10 March 2026 ===") for time-only chats. */
export function matchDateOnlyLine(line: string): ScannedMoment | null {
  if (line.length > 80) return null;
  const core = line.replace(DECORATION, '');
  if (core.length === 0) return null;
  const scanned = scanMoment(core);
  if (!scanned || scanned.time || scanned.length !== core.length) return null;
  return scanned.date || scanned.ambiguous ? scanned : null;
}

export interface LinePrefix {
  scanned: ScannedMoment;
  /** What follows the stamp, with leading separators removed. */
  rest: string;
}

const AFTER_STAMP_SEPARATOR = /^\s*(?:[-\u2013\u2014|:]\s*)?/;

/**
 * Splits `[2026-03-09 09:12] Customer: hi`, `2026-03-09T09:12:00Z - Engineer - hi` or
 * `09:12 Customer: hi` into the stamp and the remainder. Only the first 120 characters of the
 * line are examined, so very long lines cost nothing extra.
 */
export function matchLinePrefix(line: string): LinePrefix | null {
  const slice = line.slice(0, 120);
  const head = slice.trimStart();
  const offset = slice.length - head.length;
  const open = head[0];
  if (open === undefined) return null;
  let scanned: ScannedMoment | null;
  let consumed: number;
  if (open === '[' || open === '(') {
    const closer = open === '[' ? ']' : ')';
    const inner = head.slice(1).trimStart();
    const lead = head.length - 1 - inner.length;
    scanned = scanMoment(inner);
    if (!scanned?.time) return null;
    const afterStamp = inner.slice(scanned.length);
    const afterTrimmed = afterStamp.trimStart();
    if (afterTrimmed[0] !== closer) return null;
    const gap = afterStamp.length - afterTrimmed.length;
    consumed = 1 + lead + scanned.length + gap + 1;
  } else {
    scanned = scanMoment(head);
    if (!scanned?.time) return null;
    consumed = scanned.length;
  }
  const rest = line.slice(offset + consumed).replace(AFTER_STAMP_SEPARATOR, '');
  return { scanned, rest };
}

/** Whole-value parse for CSV cells and e-mail headers; trailing parenthetical notes are ignored. */
export function scanWholeValue(value: string): ScannedMoment | null {
  const trimmed = value.trim();
  if (trimmed.length > 100) return null;
  const text = trimmed.replace(/^["'[(]+|["')\]]+$/g, '');
  const scanned = scanMoment(text);
  if (!scanned) return null;
  const tail = text.slice(scanned.length).trim();
  if (tail.length > 0 && !/^[(.,;]/.test(tail)) return null;
  return scanned;
}

/** Epoch seconds or milliseconds exported by tools (10 or 13 digits). */
export function parseEpoch(value: string): number | null {
  const text = value.trim();
  if (!/^\d{10}(?:\d{3})?$/.test(text)) return null;
  const ms = text.length === 10 ? Number(text) * 1000 : Number(text);
  return isFiniteMs(ms) ? ms : null;
}
