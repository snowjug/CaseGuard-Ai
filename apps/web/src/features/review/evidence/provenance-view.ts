import {
  PARTICIPANT_ROLE_LABELS,
  type EvidenceLink,
  type ProvenanceItem,
  type ProvenanceResponse,
} from '@caseguard/schemas';
import { formatDateTimeUtc } from '@caseguard/ui';
import { shortId } from '../../../lib/format';
import { LINK_TYPE_WORDS, linkKey } from '../model/links';

/**
 * What the evidence drawer shows for each item `provenance.resolve` returned. Pure, so the three honest outcomes of a
 * check are unit-tested: a verified quotation, an excerpt that could not be matched, and a derived item with nothing
 * to quote. An excerpt is never shown as a quotation unless the server verified it against the stored message.
 */

/** The longest stretch the server returns before and after a match; a context that long was probably cut. */
const CONTEXT_CUT = 400;

export type ItemBody =
  | {
      kind: 'quote';
      before: string;
      match: string;
      after: string;
      beforeCut: boolean;
      afterCut: boolean;
    }
  /** The analysis recorded an excerpt, but the stored message does not hold it there. Not a quotation. */
  | { kind: 'mismatch' }
  /** Derived from several messages or from structured fields, so there is nothing to quote. */
  | { kind: 'derived' }
  /** The kind of item has no source text at all (a decision point, a missing-information requirement...). */
  | { kind: 'none' };

export interface ItemView {
  key: string;
  link: EvidenceLink;
  title: string;
  typeWord: string;
  /** `Support engineer · 9 Mar 2026, 12:10 UTC`, or what is known of it. */
  byline: string | null;
  /** The title of the message the item comes from, when it comes from one. */
  fromTitle: string | null;
  eventId: string | null;
  body: ItemBody;
  /** The excerpt as the analysis recorded it. Offered only inside "Details", never as a quotation. */
  recordedExcerpt: string | null;
  /** Source facts for the "Details" disclosure. */
  details: { label: string; value: string }[];
  contentHash: string | null;
}

/** The label of a link: the one the API gave, the one resolved by provenance, or the kind and a short id. */
export function linkLabel(link: EvidenceLink, resolved?: ReadonlyMap<string, string>): string {
  return (
    link.label?.trim() ||
    resolved?.get(linkKey(link))?.trim() ||
    `${LINK_TYPE_WORDS[link.type]} ${shortId(link.id, 12)}`
  );
}

function bodyOf(item: ProvenanceItem): ItemBody {
  const source = item.source;
  const textual = item.link.type === 'evidence' || item.link.type === 'claim';
  if (!source) return textual ? { kind: 'derived' } : { kind: 'none' };
  if (source.verification === 'verified' && source.context) {
    return {
      kind: 'quote',
      before: source.context.before,
      match: source.context.match,
      after: source.context.after,
      beforeCut: source.context.before.length >= CONTEXT_CUT,
      afterCut: source.context.after.length >= CONTEXT_CUT,
    };
  }
  if (source.verification === 'mismatch') return { kind: 'mismatch' };
  // `not_checkable`, and a `verified` answer that carries nothing to show: nothing is claimed about the excerpt.
  return { kind: 'derived' };
}

export function describeItem(
  item: ProvenanceItem,
  resolved?: ReadonlyMap<string, string>,
): ItemView {
  const source = item.source;
  const at = item.at ?? item.event?.timestamp ?? null;
  const who = item.event ? PARTICIPANT_ROLE_LABELS[item.event.participantRole] : null;
  const byline = [who, at ? formatDateTimeUtc(at) : null].filter(Boolean).join(' · ') || null;
  const details: ItemView['details'] = [];
  if (source) {
    details.push({ label: 'Message', value: source.eventId });
    if (source.sourceId) details.push({ label: 'Source record', value: source.sourceId });
    if (source.field) details.push({ label: 'Text measured in', value: source.field });
    if (source.start !== null && source.end !== null) {
      details.push({ label: 'Position in that text', value: `${source.start} to ${source.end}` });
    }
  }
  return {
    key: linkKey(item.link),
    link: item.link,
    title: item.title.trim() || linkLabel(item.link, resolved),
    typeWord: LINK_TYPE_WORDS[item.link.type],
    byline,
    fromTitle: item.event?.title ?? null,
    eventId:
      item.event?.id ?? source?.eventId ?? (item.link.type === 'event' ? item.link.id : null),
    body: bodyOf(item),
    recordedExcerpt: source?.excerpt ?? null,
    details,
    contentHash: source?.contentHash ?? null,
  };
}

/** The items with the one the person asked about first, the rest in the order the links were given. */
export function orderItems(
  items: readonly ProvenanceItem[],
  focusKey: string | null,
): ProvenanceItem[] {
  if (!focusKey) return [...items];
  const focused = items.filter((item) => linkKey(item.link) === focusKey);
  return [...focused, ...items.filter((item) => linkKey(item.link) !== focusKey)];
}

export const UNRESOLVED_WORDS: Record<ProvenanceResponse['unresolved'][number]['reason'], string> =
  {
    not_found: 'This item is not in the case any more, or never was.',
    not_yet_known: 'This item was recorded after the moment being looked at.',
  };

/** Titles by link key, to label chips that arrive without a label. */
export function titlesByKey(response: ProvenanceResponse | undefined): Map<string, string> {
  return new Map(
    (response?.items ?? []).flatMap((item) =>
      item.title.trim() ? [[linkKey(item.link), item.title.trim()] as const] : [],
    ),
  );
}
