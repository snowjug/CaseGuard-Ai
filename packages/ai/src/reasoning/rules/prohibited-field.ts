import { findProhibitedFields } from '@caseguard/schemas';
import { sanitisePath } from '../text';
import type { ProposalIssue } from '../types';

/**
 * A reply must never name a field only the server may set: a status, an approval, a review state, a claim that the
 * engine agrees. Naming one (to approve itself, say) is reported on its own and not as a generic schema error.
 * Case, underscores and hyphens do not hide a name.
 */
export function checkProhibitedField(raw: unknown): ProposalIssue[] {
  return findProhibitedFields(raw)
    .slice(0, 5)
    .map((path) => ({
      code: 'prohibited_field' as const,
      path: sanitisePath(path),
      message: 'The proposal names a field that only the server may set.',
    }));
}
