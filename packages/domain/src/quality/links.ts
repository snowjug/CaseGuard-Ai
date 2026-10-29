import type { CaseEvent, EvidenceLink } from '@caseguard/schemas';

/** Shortens text for contract fields with a maximum length (adds an ellipsis when cut). */
export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function evidenceLink(
  type: EvidenceLink['type'],
  id: string,
  label?: string | null,
): EvidenceLink {
  return label
    ? { type, id: id.slice(0, 120), label: truncate(label, 200) }
    : { type, id: id.slice(0, 120) };
}

export const eventLink = (event: Pick<CaseEvent, 'id' | 'title' | 'type'>): EvidenceLink =>
  evidenceLink('event', event.id, event.title ?? event.type);

/** Removes duplicate links (same type and id) while keeping order, and bounds the list. */
export function uniqueLinks(links: readonly EvidenceLink[], max = 12): EvidenceLink[] {
  const seen = new Set<string>();
  const out: EvidenceLink[] = [];
  for (const link of links) {
    const key = `${link.type}:${link.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(link);
    if (out.length >= max) break;
  }
  return out;
}

export const pct = (p: number): string => `${Math.round(p * 100)}%`;

export const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;
