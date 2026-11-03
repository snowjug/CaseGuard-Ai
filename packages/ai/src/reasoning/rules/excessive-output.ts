import type { FindingType } from '@caseguard/schemas';
import { sanitisePath } from '../text';
import type { ProposalIssue } from '../types';
import { parseProposal, pathOf } from './parse';

const TOO_BIG = 'A string or a list of the proposal is longer than the allowed size.';

/** A string or a list inside one proposal that is longer than its cap (statement 300, reasoning 500, six citations...). */
export function checkExcessiveOutput(type: FindingType, raw: unknown): ProposalIssue[] {
  return parseProposal(type, raw)
    .issues.filter((issue) => issue.code === 'too_big')
    .slice(0, 5)
    .map((issue) => ({
      code: 'excessive_output' as const,
      path: sanitisePath(pathOf(issue.path)),
      message: TOO_BIG,
    }));
}

/** The reply as a whole is larger than the size cap: nothing in it is read. */
export function checkReplySize(serialisedLength: number, maxChars: number): ProposalIssue[] {
  return serialisedLength > maxChars
    ? [
        {
          code: 'excessive_output',
          path: '$',
          message: `The reply exceeds the ${maxChars} character limit.`,
        },
      ]
    : [];
}

/** The first `cap` items of a list and, for the ones past it, one `excessive_output` issue each. */
export function splitOverflow<T>(
  items: readonly T[],
  cap: number,
  path: string,
): { within: T[]; overflow: ProposalIssue[] } {
  return {
    within: items.slice(0, cap),
    overflow: items.slice(cap).map((_, i) => ({
      code: 'excessive_output' as const,
      path: `${path}[${cap + i}]`,
      message: 'The list holds more proposals than the cap for its type.',
    })),
  };
}
