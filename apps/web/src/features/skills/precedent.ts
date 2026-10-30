import type { SkillPrecedentComparison } from '@caseguard/schemas';
import { formatNumber } from '../../lib/format';

/** Shown in place of a figure the API could not measure: a missing figure is never shown as zero. */
export const NOT_MEASURED = 'Not measured';

/** How to read the signs and the order of the figures in the headline (the direction of each figure is easy to misread). */
export const PRECEDENT_READING_GUIDE =
  'Times are minutes to diagnosis: with the skill first, then on that case’s recorded path. A negative token change means fewer estimated tokens. Evidence is the change in how much of the minimum evidence was in place, in percentage points: positive means more complete.';

/** `A`, `A and B`, `A, B and C`: the references of the cases a skill came from, in one phrase. */
export function joinReferences(references: readonly string[]): string {
  const last = references.at(-1);
  if (last === undefined) return '';
  return references.length === 1 ? last : `${references.slice(0, -1).join(', ')} and ${last}`;
}

/** Exact minutes: a duration rounded to days would hide up to a day of difference between two recorded paths. */
function minutesText(minutes: number): string {
  return `${formatNumber(minutes, { maximumFractionDigits: 1 })} min`;
}

/** A signed change the API sent (`-79.5%`, `+5 points`), or `unchanged` when it rounds to nothing at one decimal. */
function changeText(value: number, unit: string): string {
  const rounded = Math.round(value * 10) / 10;
  if (rounded === 0) return 'unchanged';
  return `${formatNumber(rounded, { signed: true, maximumFractionDigits: 1 })}${unit}`;
}

/** `1 application`, `3 applications`, or `1 of 3 applications` when some applications could not be compared. */
function applicationsText(compared: number, total: number): string {
  if (total > compared) return `${compared} of ${total} applications`;
  return `${compared} ${compared === 1 ? 'application' : 'applications'}`;
}

/** The name of the block that headlines the comparison with the case (or cases) the skill came from. */
export function precedentTitle(precedent: SkillPrecedentComparison): string {
  return `Against the ${precedent.references.length > 1 ? 'cases' : 'case'} the skill came from`;
}

/**
 * The headline of the like-for-like comparison, from the figures the API sent and nothing else:
 * `Compared with CG-SYN-1001: 183 min vs 2,994 min to diagnosis; tokens -79.5%; evidence unchanged; 1 application.`
 * A figure the API could not measure reads "Not measured", never zero. `applications` is the skill's total, so a
 * comparison that covers only some of them says so.
 */
export function precedentHeadline(
  precedent: SkillPrecedentComparison,
  applications: number,
): string {
  const { avgTimeToDiagnosisMinutes: withSkill, precedentAvgTimeToDiagnosisMinutes: earlier } =
    precedent;
  const time =
    withSkill !== null && earlier !== null
      ? `${minutesText(withSkill)} vs ${minutesText(earlier)} to diagnosis`
      : `time to diagnosis: ${NOT_MEASURED}`;
  const tokens =
    precedent.tokenChangePct === null
      ? `tokens: ${NOT_MEASURED}`
      : `tokens ${changeText(precedent.tokenChangePct, '%')}`;
  const evidence =
    precedent.evidenceCompletenessPoints === null
      ? `evidence: ${NOT_MEASURED}`
      : `evidence ${changeText(precedent.evidenceCompletenessPoints, ' points')}`;
  const against =
    precedent.references.length > 0
      ? joinReferences(precedent.references)
      : 'the case the skill came from';
  const parts = [time, tokens, evidence, applicationsText(precedent.cases, applications)];
  return `Compared with ${against}: ${parts.join('; ')}.`;
}
