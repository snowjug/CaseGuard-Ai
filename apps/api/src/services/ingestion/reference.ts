import type { CaseListItem, TenantRepositories } from '../../db';
import { ConflictError } from '../../errors';

const PAGE_SIZE = 200;
const MAX_PAGES = 10;

/**
 * The case of this tenant that already uses `reference`, or null. The case table has no unique index
 * on the reference (only on the content), so this searches: `q` narrows by substring and the exact
 * comparison decides. It is the one place that knows how; preview and ingestion both ask it, so what
 * a preview says about a reference is what the create then does. Two concurrent requests with the
 * same new reference can still both pass, and a search that runs past its page budget gives up
 * without a verdict (an exact lookup in the data tier would remove both limits).
 */
export async function findCaseByReference(
  repos: TenantRepositories,
  reference: string,
): Promise<CaseListItem | null> {
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await repos.cases.list({
      limit: PAGE_SIZE,
      q: reference,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const found = result.items.find((item) => item.reference === reference);
    if (found !== undefined) return found;
    if (result.nextCursor === null) return null;
    cursor = result.nextCursor;
  }
  return null;
}

/** The reference is validated (upper-case letters, digits, dashes), so it is safe to show. */
export function referenceInUseMessage(reference: string): string {
  return `A case with reference ${reference} already exists in this workspace with different content. Change the case reference in the payload, or delete the existing case first.`;
}

export function referenceConflict(reference: string): ConflictError {
  return new ConflictError(referenceInUseMessage(reference), { reason: 'reference_in_use' });
}
