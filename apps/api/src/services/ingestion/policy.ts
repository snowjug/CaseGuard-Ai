import type { ValidationIssue } from '@caseguard/schemas';
import { errorIssue, warningIssue } from './issues';

/*
 * Data-handling policy. CaseGuard is a synthetic-data platform (assumption A-02): a workspace whose
 * tenant is flagged `synthetic` refuses payloads that declare `"synthetic": false`. The only switch
 * that can lift this is the tenant flag itself, because the governance settings carry no data-handling
 * option; a tenant that an operator provisioned as non-synthetic may ingest real data, which is then
 * redacted harder (reserved test values too) and stored labelled `synthetic=false`.
 */

/** Pasted text and CSV carry no synthetic label, so they inherit the tenant's; say so. */
export function syntheticLabelNote(tenantSynthetic: boolean): ValidationIssue {
  return tenantSynthetic
    ? warningIssue(
        'synthetic',
        'Note: pasted text and CSV files carry no label of their own, so they are labelled synthetic because this workspace holds synthetic data only. Use fictional data only.',
      )
    : warningIssue(
        'synthetic',
        'Note: this workspace is not marked synthetic, so pasted text and CSV files are treated as real data: they are redacted, including reserved test values, and stored labelled synthetic=false.',
      );
}

/** The policy verdict for a parsed payload: an error (refused), a note (accepted as real data) or nothing. */
export function checkDataPolicy(input: {
  readonly tenantSynthetic: boolean;
  readonly bundleSynthetic: boolean;
  /** The label was taken from the tenant, not declared by the payload: nothing to decide here. */
  readonly labelDerived: boolean;
}): ValidationIssue | null {
  if (input.bundleSynthetic || input.labelDerived) return null;
  if (input.tenantSynthetic) {
    return errorIssue(
      'synthetic',
      'This workspace accepts synthetic data only, but the payload is marked "synthetic": false. Remove real customer data; set "synthetic": true only when every organisation, person, address and incident in it is fictional.',
    );
  }
  return warningIssue(
    'synthetic',
    'Note: the payload is marked "synthetic": false. It is redacted, including reserved test values, and stored labelled synthetic=false.',
  );
}
