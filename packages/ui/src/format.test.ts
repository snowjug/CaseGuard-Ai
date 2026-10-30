import { describe, expect, it } from 'vitest';
import {
  NOT_AVAILABLE,
  formatDateTimeUtc,
  formatDateUtc,
  formatDayMonthUtc,
  formatDuration,
  formatMetricValue,
  formatNumber,
  formatPercent,
  formatProbability,
  formatRelativeTime,
  formatTimeUtc,
} from './format';

describe('UTC-explicit formatting', () => {
  it('always prints the time zone next to the time', () => {
    expect(formatDateTimeUtc('2025-03-14T09:42:07Z')).toBe('14 Mar 2025, 09:42 UTC');
    expect(formatDateTimeUtc('2025-03-14T09:42:07Z', { seconds: true })).toBe(
      '14 Mar 2025, 09:42:07 UTC',
    );
    expect(formatTimeUtc('2025-03-14T23:05:00Z')).toBe('23:05 UTC');
    expect(formatDateUtc('2025-12-01T00:00:00Z')).toBe('1 Dec 2025');
    expect(formatDayMonthUtc('2025-03-14T09:42:00Z')).toBe('14 Mar');
    expect(formatDayMonthUtc('2025-03-14T09:42:00Z', true)).toBe('14 Mar 2025');
  });

  it('does not shift the date when the runtime time zone differs from UTC', () => {
    // 23:30 UTC is already the next day in UTC+2: the UI must still say 14 Mar.
    expect(formatDateUtc('2025-03-14T23:30:00Z')).toBe('14 Mar 2025');
  });

  it('returns a dash for missing or invalid values instead of throwing', () => {
    expect(formatDateTimeUtc(null)).toBe(NOT_AVAILABLE);
    expect(formatDateTimeUtc('not a date')).toBe(NOT_AVAILABLE);
    expect(formatNumber(Number.NaN)).toBe(NOT_AVAILABLE);
    expect(formatDuration(undefined)).toBe(NOT_AVAILABLE);
  });
});

describe('durations and numbers', () => {
  it('shows the two most significant units', () => {
    expect(formatDuration(0)).toBe('0 min');
    expect(formatDuration(45)).toBe('45 min');
    expect(formatDuration(125)).toBe('2 h 05 min');
    expect(formatDuration(60)).toBe('1 h');
    expect(formatDuration(1440)).toBe('1 d');
    expect(formatDuration(1440 * 3 + 60 * 4 + 30)).toBe('3 d 4 h');
    expect(formatDuration(-90)).toBe('-1 h 30 min');
  });

  it('formats numbers, probabilities and percentages deterministically', () => {
    expect(formatNumber(1234.567)).toBe('1,234.6');
    expect(formatNumber(4.2, { signed: true })).toBe('+4.2');
    expect(formatNumber(-4.2, { signed: true })).toBe('-4.2');
    expect(formatProbability(0.624)).toBe('62%');
    expect(formatProbability(0.6249, 1)).toBe('62.5%');
    expect(formatPercent(37.5, 1)).toBe('37.5%');
  });

  it('formats metric values by unit', () => {
    expect(formatMetricValue(72, 'score')).toBe('72');
    expect(formatMetricValue(36.5, 'percent')).toBe('37%');
    expect(formatMetricValue(95, 'minutes')).toBe('1 h 35 min');
    expect(formatMetricValue(1.256, 'bits_per_1k_tokens')).toBe('1.26 bits/1k tokens');
  });

  it('formats relative time against an injected clock', () => {
    const now = new Date('2025-03-14T12:00:00Z');
    expect(formatRelativeTime('2025-03-14T11:30:00Z', now)).toBe('30 min ago');
    expect(formatRelativeTime('2025-03-14T12:00:20Z', now)).toBe('just now');
    expect(formatRelativeTime('2025-03-14T14:00:00Z', now)).toBe('in 2 h');
    expect(formatRelativeTime('2025-01-01T00:00:00Z', now)).toBe('1 Jan 2025, 00:00 UTC');
  });
});
