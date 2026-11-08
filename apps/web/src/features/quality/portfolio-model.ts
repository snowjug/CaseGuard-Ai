import type { AnalyticsOverview } from '@caseguard/schemas';
import { formatNumber, formatPercent } from '../../lib/format';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-03` becomes `Mar 2026`; any other bucket label the API sends (a week, a day) is shown as it is. */
export function formatPeriod(period: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  const month = match?.[2] ? MONTHS[Number.parseInt(match[2], 10) - 1] : undefined;
  return match && month ? `${month} ${match[1]}` : period;
}

/** The sample-size sentence is a warning while fewer than ten cases were analysed. */
export function isSmallSample(cohort: AnalyticsOverview['cohort']): boolean {
  return cohort.analyzedCaseCount < 10;
}

type SkillEffectivenessRow = AnalyticsOverview['skillEffectiveness'][number];

/** What the API compared a skill's time to diagnosis with (`timeToDiagnosisBasis`). It is absent on older records. */
export type TimeBasis = NonNullable<SkillEffectivenessRow['timeToDiagnosisBasis']>;

/**
 * Time to diagnosis against its basis, in words. The API's figure is `(basis - now) / basis`, so a positive value is
 * faster and a negative one slower; a missing value is "not enough data", never zero. With a basis the sentence is
 * short and `timeBasisText` names what it is compared with; without one the older wording ("the baseline") stays.
 */
export function timeDeltaText(deltaPct: number | null, basis?: TimeBasis): string {
  if (deltaPct === null) return 'Not enough data';
  if (deltaPct === 0) return basis ? 'No change' : 'No change from the baseline';
  const size = formatPercent(Math.abs(deltaPct), 1);
  const direction = deltaPct > 0 ? 'faster' : 'slower';
  return basis ? `${size} ${direction}` : `${size} ${direction} than the baseline`;
}

/**
 * What a skill's time to diagnosis is compared with, as a caption for the figure: the recorded path of the case the
 * skill came from (like for like) or a simulated baseline (which has no waiting between steps). Null when the API did
 * not say.
 */
export function timeBasisText(basis: TimeBasis | undefined): string | null {
  switch (basis) {
    case 'earlier_case':
      return 'vs the case it came from';
    case 'simulated_baseline':
      return 'vs a simulated baseline';
    default:
      return null;
  }
}

/** A rate between 0 and 1 that may not exist yet (nothing reviewed). */
export function optionalRate(rate: number | null, whenNull: string): string {
  return rate === null ? whenNull : `${formatNumber(rate * 100, { maximumFractionDigits: 0 })}%`;
}

/** `1 case` / `3 cases`. */
export function casesText(count: number): string {
  return `${count} ${count === 1 ? 'case' : 'cases'}`;
}

/** A whole number for a count chart; the axis tick that falls between two whole numbers stays blank, never "1, 1, 2, 2". */
export function formatCount(value: number): string {
  return Number.isInteger(value) ? formatNumber(value, { maximumFractionDigits: 0 }) : '';
}

type TrendRow = AnalyticsOverview['qualityTrend'][number];

/**
 * The average score over every analysed case, from the monthly averages weighted by their cases (so it is the figure the
 * bars add up to, not an average of averages). Null when no month has a score.
 */
export function averageQuality(
  trend: readonly TrendRow[],
): { value: number; caseCount: number } | null {
  let sum = 0;
  let count = 0;
  for (const row of trend) {
    if (row.avgQuality === null || row.caseCount === 0) continue;
    sum += row.avgQuality * row.caseCount;
    count += row.caseCount;
  }
  return count === 0 ? null : { value: sum / count, caseCount: count };
}

/** True when every month holds a single case: each bar is then that case's own estimate, not a trend. */
export function isEveryMonthOneCase(trend: readonly TrendRow[]): boolean {
  return trend.length > 0 && trend.every((row) => row.caseCount === 1);
}

/**
 * How the latest month moved from the one before it, in points. Null while there is nothing to compare or when every
 * month holds one case (that would present two single cases as a movement).
 */
export function trendChange(
  trend: readonly TrendRow[],
): { points: number; from: string; to: string } | null {
  const scored = trend.filter((row) => row.avgQuality !== null);
  const latest = scored.at(-1);
  const before = scored.at(-2);
  if (!latest || !before || isEveryMonthOneCase(trend)) return null;
  return {
    points: (latest.avgQuality ?? 0) - (before.avgQuality ?? 0),
    from: before.period,
    to: latest.period,
  };
}

/**
 * The one figure about time in the portfolio: the average share of waiting time (to diagnosis) that a better-sequenced
 * path would have avoided, over the cases that have an estimate. The overview carries no overall figure for the
 * estimate, so this does not pretend to be one. Null when no case has it.
 */
export function waitingTimeSaved(
  patterns: AnalyticsOverview['avoidableEffortPatterns'],
): { pct: number; caseCount: number } | null {
  const row = patterns.find((pattern) => pattern.component === 'waiting_time');
  return row ? { pct: row.avgAvoidablePct, caseCount: row.caseCount } : null;
}
