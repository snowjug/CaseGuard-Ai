import { formatDateTimeUtc } from '@caseguard/ui';
import type { NextActionsModel } from './actions';
import type { MissedMoment, VerdictModel } from './verdict';

/** What the short share summary is built from; every part is optional because a role may not be able to read it. */
export interface ShareInput {
  reference: string;
  title: string;
  synthetic: boolean;
  verdict: VerdictModel | null;
  missed: MissedMoment | null | undefined;
  /** `undefined` when the decision points could not be read; `null` when there is none. */
  actions: NextActionsModel | null;
  /** The address of the full report. */
  reportUrl: string;
  /** Parts that were left out, named for the reader. */
  notIncluded: readonly string[];
  /** How many recommendations to list. */
  top?: number;
}

/**
 * A short plain-text summary of the review for a chat message or an email: the verdict, the earliest important missed
 * moment and the first recommendations, with the honesty labels kept and a link to the full report. Nothing is added that
 * the review does not say, and what could not be read is named, not skipped in silence.
 */
export function shareSummary(input: ShareInput): string {
  const lines: string[] = [`CaseGuard guided review: ${input.reference}, ${input.title}`];
  if (input.verdict && !input.verdict.placeholder) lines.push(input.verdict.headline);
  if (input.missed) {
    lines.push(
      `Earliest important missed moment: ${input.missed.title} (${formatDateTimeUtc(input.missed.at)}). What was done: ${input.missed.didLabel}.${
        input.missed.betterLabel
          ? ` A better-supported step was available: ${input.missed.betterLabel}.`
          : ''
      }`,
    );
  } else if (input.missed === null) {
    lines.push('No decision point stood out as having a clearly better step available.');
  }
  const top = input.actions?.items.slice(0, input.top ?? 3) ?? [];
  if (top.length > 0) {
    lines.push('Next actions:');
    top.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.title} (${item.priorityLabel.toLowerCase()})`);
    });
  }
  if (input.notIncluded.length > 0) lines.push(`Not included: ${input.notIncluded.join('; ')}.`);
  lines.push(
    `Case quality and every range are estimates, and simulated figures are what-ifs, not measurements.${
      input.synthetic ? ' This case uses synthetic data.' : ''
    }`,
  );
  lines.push(`Full report: ${input.reportUrl}`);
  return lines.join('\n');
}
