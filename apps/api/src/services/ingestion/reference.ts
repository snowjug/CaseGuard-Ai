import type { Case } from '@caseguard/schemas';
import type { TenantRepositories } from '../../db';
import { ConflictError } from '../../errors';

/**
 * The case of this tenant that uses `reference`, or null: an exact, tenant-scoped lookup. A reference
 * is unique within a tenant (the `cases_tenant_reference_uq` constraint), so there is at most one.
 * Preview and ingestion both ask here, so what a preview says about a reference is what the create
 * then does. Two requests that pass this check at the same moment are settled by the constraint:
 * `persistCase` answers the one that loses with the same conflict (`settleDuplicate`).
 */
export function findCaseByReference(
  repos: TenantRepositories,
  reference: string,
): Promise<Case | null> {
  return repos.cases.findByReference(reference);
}

/**
 * The reference is validated (upper-case letters, digits, dashes), so it is safe to show. The advice
 * does not assume where the payload came from: a bundle, a pasted transcript and a CSV all have one.
 */
export function referenceInUseMessage(reference: string): string {
  return `A case with reference ${reference} already exists in this workspace with different content. Use a different case reference, or delete the existing case first.`;
}

export function referenceConflict(reference: string): ConflictError {
  return new ConflictError(referenceInUseMessage(reference), { reason: 'reference_in_use' });
}
