import { SECRET_REDACTION_CATEGORIES, redactValue } from '@caseguard/security';

/**
 * Masks credentials in data that is about to leave the API (audit details, reviewer text, exports) and
 * changes nothing else, so legitimate ids, hashes and counters stay byte-identical. `replacements` is
 * how many values were masked; it is 0 for well-formed records.
 *
 * Only credential categories run here: personal-data categories are a tenant choice applied at
 * ingestion, and masking them again would alter evidence the analysis legitimately kept.
 */
export function maskSecrets<T>(value: T): { value: T; replacements: number } {
  const result = redactValue(value, { enabledCategories: SECRET_REDACTION_CATEGORIES });
  return { value: result.value, replacements: result.totalReplacements };
}
