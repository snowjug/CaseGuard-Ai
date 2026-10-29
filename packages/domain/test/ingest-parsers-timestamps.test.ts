import { describe, expect, it } from 'vitest';
import {
  formatIso,
  matchDateOnlyLine,
  matchLinePrefix,
  parseCalendarDate,
  parseEpoch,
  resolveMoment,
  scanMoment,
  scanWholeValue,
  type MomentContext,
} from '../src/ingest/parsers/timestamps';

const ctx: MomentContext = { currentDate: null, assumedOffsetMinutes: 0, dateOrder: null };

function resolve(text: string, context: Partial<MomentContext> = {}) {
  const scanned = scanMoment(text);
  if (!scanned) return null;
  return resolveMoment(scanned, { ...ctx, ...context });
}

describe('resolveMoment: calendar and clock validation', () => {
  const valid: [string, string][] = [
    ['2028-02-29 10:00 UTC', '2028-02-29T10:00:00Z'],
    ['2026-12-31 23:59:59 UTC', '2026-12-31T23:59:59Z'],
    ['1970-01-01 00:00 UTC', '1970-01-01T00:00:00Z'],
    ['2100-12-31 23:59 UTC', '2100-12-31T23:59:00Z'],
    ['2026-03-09 12:00 AM UTC', '2026-03-09T00:00:00Z'],
    ['2026-03-09 12:00 PM UTC', '2026-03-09T12:00:00Z'],
    ['2026-03-09 11:59 pm UTC', '2026-03-09T23:59:00Z'],
    ['2026-03-09 09:12 -05:30', '2026-03-09T14:42:00Z'],
    ['2026-03-09 09:12 GMT+1', '2026-03-09T08:12:00Z'],
    ['2026-03-09T09:12:00.5Z', '2026-03-09T09:12:00.500Z'],
    ['2026-03-09T09:12:00,25Z', '2026-03-09T09:12:00.250Z'],
    ['1 Jan 2026 00:00 UTC', '2026-01-01T00:00:00Z'],
    ['Sat, 31 Dec 2026 23:00:00 +0100', '2026-12-31T22:00:00Z'],
    ['September 5th, 2026 8:05 AM UTC', '2026-09-05T08:05:00Z'],
  ];

  it.each(valid)('[FR-ING-01] reads %s', (text, iso) => {
    const result = resolve(text);
    expect(result?.ok).toBe(true);
    if (result?.ok) expect(formatIso(result.value.ms)).toBe(iso);
  });

  const invalid: [string, string][] = [
    ['2027-02-29 10:00 UTC', 'invalid_date'],
    ['2026-04-31 10:00 UTC', 'invalid_date'],
    ['2026-13-01 10:00 UTC', 'invalid_date'],
    ['2026-00-10 10:00 UTC', 'invalid_date'],
    ['1969-12-31 10:00 UTC', 'out_of_range'],
    ['2101-01-01 10:00 UTC', 'out_of_range'],
    ['2026-03-09 10:60 UTC', 'invalid_time'],
    ['2026-03-09 25:00 UTC', 'invalid_time'],
    ['2026-03-09 24:00 UTC', 'invalid_time'],
    ['2026-03-09 23:59:60 UTC', 'invalid_time'],
    ['2026-03-09 13:00 PM UTC', 'invalid_time'],
    ['2026-03-09 0:30 AM UTC', 'invalid_time'],
    ['03/09/2026 10:00 UTC', 'ambiguous_date'],
  ];

  it.each(invalid)('[FR-ING-01] refuses %s as %s', (text, reason) => {
    const result = resolve(text);
    expect(result).toMatchObject({ ok: false, reason });
  });

  it('[FR-ING-01] needs a date for a bare time and says so', () => {
    expect(resolve('09:12')).toMatchObject({ ok: false, reason: 'no_date' });
    const withDate = resolve('09:12', { currentDate: { year: 2026, month: 3, day: 9 } });
    expect(withDate?.ok && formatIso(withDate.value.ms)).toBe('2026-03-09T09:12:00Z');
    expect(withDate?.ok && withDate.value.assumedDate).toBe(true);
  });

  it('[FR-ING-01] day and month order follow the value or the supplied order, never a guess', () => {
    expect(resolve('13/01/2026 10:00 UTC')).toMatchObject({ ok: true });
    expect(resolve('01/13/2026 10:00 UTC')).toMatchObject({ ok: true });
    expect(resolve('05/05/2026 10:00 UTC')).toMatchObject({ ok: true });
    expect(resolve('03/04/2026 10:00 UTC')).toMatchObject({ ok: false, reason: 'ambiguous_date' });
    const dmy = resolve('03/04/2026 10:00 UTC', { dateOrder: 'dmy' });
    const mdy = resolve('03/04/2026 10:00 UTC', { dateOrder: 'mdy' });
    expect(dmy?.ok && formatIso(dmy.value.ms)).toBe('2026-04-03T10:00:00Z');
    expect(mdy?.ok && formatIso(mdy.value.ms)).toBe('2026-03-04T10:00:00Z');
  });

  it('[FR-ING-01] marks stamps without a zone so the caller can warn', () => {
    expect(resolve('2026-03-09 10:00')).toMatchObject({ ok: true, value: { assumedZone: true } });
    expect(resolve('2026-03-09 10:00 UTC')).toMatchObject({
      ok: true,
      value: { assumedZone: false },
    });
    expect(resolve('2026-03-09 10:00 +00:00')).toMatchObject({
      ok: true,
      value: { assumedZone: false },
    });
  });

  it('[FR-ING-01] rejects offsets outside +-14 hours instead of reading them as something else', () => {
    const scanned = scanMoment('2026-03-09 10:00 +15:00');
    expect(scanned?.offsetMinutes).toBeNull();
  });
});

describe('line prefixes', () => {
  const prefixes: [string, string][] = [
    ['[2026-03-09 09:12] Customer: hi', 'Customer: hi'],
    ['  [ 2026-03-09 09:12 UTC ]   Customer: hi', 'Customer: hi'],
    ['(09:12:30) Support: hi', 'Support: hi'],
    ['2026-03-09T09:12:00Z - Engineer - hi', 'Engineer - hi'],
    ['2026-03-09 09:12:30 | Support: hi', 'Support: hi'],
    ['09:12 Customer: hi', 'Customer: hi'],
    ['9:12 AM Customer: hi', 'Customer: hi'],
    ['[09:12]: Customer: hi', 'Customer: hi'],
    ['[Mon, 9 Mar 2026 09:12:00 +0000] Support: hi', 'Support: hi'],
  ];

  it.each(prefixes)('[FR-ING-01] splits %s', (line, rest) => {
    expect(matchLinePrefix(line)?.rest).toBe(rest);
  });

  const notPrefixes = [
    'Customer: hi',
    '[Customer] hi',
    '[2026-03-09] no time here',
    '2026-03-09 no time either',
    '10 users failed',
    '[09:12 missing bracket',
    '',
    '   ',
  ];

  it.each(notPrefixes)('[FR-ING-01] does not treat %j as a timestamp', (line) => {
    expect(matchLinePrefix(line)).toBeNull();
  });

  it('[FR-ING-01] only looks at the start of a line, however long it is', () => {
    const long = `[2026-03-09 09:12 UTC] Customer: ${'x'.repeat(500_000)}`;
    expect(matchLinePrefix(long)?.rest.startsWith('Customer: xxx')).toBe(true);
    expect(matchLinePrefix(`${' '.repeat(500_000)}[2026-03-09 09:12] a: b`)).toBeNull();
  });

  it('[FR-ING-01] recognises lines that only announce a date', () => {
    expect(matchDateOnlyLine('=== Tuesday, 10 March 2026 ===')).toMatchObject({
      date: { year: 2026, month: 3, day: 10 },
    });
    expect(matchDateOnlyLine('--- 2026-03-10 ---')).not.toBeNull();
    expect(matchDateOnlyLine('2026-03-10 09:00 Customer: hi')).toBeNull();
    expect(matchDateOnlyLine('The meeting was on 2026-03-10')).toBeNull();
    expect(matchDateOnlyLine('x'.repeat(100))).toBeNull();
  });
});

describe('whole values and helpers', () => {
  it('[FR-ING-02] reads header and cell values, ignoring a trailing note but not trailing words', () => {
    expect(scanWholeValue('  "2026-03-09 09:12 UTC"  ')?.time?.hour).toBe(9);
    expect(scanWholeValue('2026-03-09 09:12 UTC (approx.)')).not.toBeNull();
    expect(scanWholeValue('2026-03-09 09:12 UTC and later')).toBeNull();
    expect(scanWholeValue('x'.repeat(200))).toBeNull();
  });

  it('[FR-ING-02] accepts epoch seconds and milliseconds only in a sane range', () => {
    expect(parseEpoch('1773046800')).toBe(1_773_046_800_000);
    expect(parseEpoch('1773046800123')).toBe(1_773_046_800_123);
    expect(parseEpoch('17730468')).toBeNull();
    expect(parseEpoch('99999999999')).toBeNull();
    expect(parseEpoch('9999999999999')).toBeNull();
    expect(parseEpoch('1773046800.5')).toBeNull();
  });

  it('[FR-ING-01] parses only real YYYY-MM-DD default dates', () => {
    expect(parseCalendarDate('2026-03-09')).toEqual({ year: 2026, month: 3, day: 9 });
    expect(parseCalendarDate(' 2026-03-09 ')).not.toBeNull();
    for (const bad of ['2026-3-9', '2026-02-30', '09/03/2026', '', '2026-03-09T00:00:00Z']) {
      expect(parseCalendarDate(bad)).toBeNull();
    }
  });

  it('[FR-ING-01] formats whole seconds without a fraction and keeps milliseconds', () => {
    expect(formatIso(Date.UTC(2026, 2, 9, 9, 12, 0))).toBe('2026-03-09T09:12:00Z');
    expect(formatIso(Date.UTC(2026, 2, 9, 9, 12, 0, 7))).toBe('2026-03-09T09:12:00.007Z');
  });
});
