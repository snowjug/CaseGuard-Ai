/**
 * Formatting for the web app. Everything is UTC-explicit (the time zone is always printed) and lives in
 * `@caseguard/ui` so charts, the time cursor and pages agree. Import from here in pages.
 */
export {
  NOT_AVAILABLE,
  formatDateTimeUtc,
  formatDateUtc,
  formatDayMonthUtc,
  formatDuration,
  formatMetricValue,
  formatNumber,
  formatPercent,
  formatProbability,
  formatTimeUtc,
} from '@caseguard/ui';

/** Short id for display: `case_01HZX...` becomes `case_01HZX…` (the full id stays in titles and URLs). */
export function shortId(id: string, length = 14): string {
  return id.length <= length ? id : `${id.slice(0, length)}…`;
}
