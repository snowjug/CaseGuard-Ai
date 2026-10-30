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
