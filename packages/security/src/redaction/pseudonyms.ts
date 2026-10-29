/** Categories whose distinct values get numbered pseudonyms so analysis can tell them apart. */
export type PseudonymCategory = 'email_address' | 'ipv4_address' | 'phone_number';

const PSEUDONYM_IN_TEXT = /\[REDACTED:(email_address|ipv4_address|phone_number)#(\d{1,9})\]/g;
/** Bounds memory when one state sees an adversarial number of distinct values. */
const MAX_DISTINCT_PER_CATEGORY = 50_000;

/**
 * Remembers which pseudonym number each distinct value received, so one document (or one case)
 * redacts `a@x.com` to the same `[REDACTED:email_address#1]` everywhere. Use one state per
 * document or per case; never share a state across tenants.
 */
export interface PseudonymState {
  /** 1-based number for `key`, or `null` once the per-category cap is reached. */
  indexFor(category: PseudonymCategory, key: string): number | null;
  /** Skips numbers already present in `text` so pseudonyms from earlier runs are never reused. */
  reserveFrom(text: string): void;
}

export function createPseudonymState(): PseudonymState {
  const assigned = new Map<PseudonymCategory, Map<string, number>>();
  const next = new Map<PseudonymCategory, number>();

  return {
    indexFor(category, key) {
      let known = assigned.get(category);
      if (known === undefined) {
        known = new Map();
        assigned.set(category, known);
      }
      const existing = known.get(key);
      if (existing !== undefined) return existing;
      if (known.size >= MAX_DISTINCT_PER_CATEGORY) return null;
      const index = next.get(category) ?? 1;
      next.set(category, index + 1);
      known.set(key, index);
      return index;
    },
    reserveFrom(text) {
      if (!text.includes('[REDACTED:')) return;
      for (const match of text.matchAll(PSEUDONYM_IN_TEXT)) {
        const category = match[1] as PseudonymCategory;
        const used = Number(match[2]);
        if ((next.get(category) ?? 1) <= used) next.set(category, used + 1);
      }
    },
  };
}
