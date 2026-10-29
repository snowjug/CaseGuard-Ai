import { AGENT_CATALOG } from '../agents/catalog';
import type { ContextIndex, EventStamp } from '../context/types';
import { wordShingles } from '../util/text';
import { safeId } from './citations';
import type { OutputIssue, ValidationContext } from './types';
import { collectCitations, collectTexts, type CitationRef } from './walk';

const MAX_ISSUES = 20;
const SHINGLE_SIZE = 6;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function stampOf(ref: CitationRef, index: ContextIndex): EventStamp | null {
  if (ref.kind === 'event' || ref.kind === 'anchor_event') {
    return index.events.get(ref.id) ?? index.anchors.get(ref.id) ?? null;
  }
  if (ref.kind === 'evidence') {
    const eventId = index.evidence.get(ref.id)?.eventId;
    return eventId ? (index.events.get(eventId) ?? null) : null;
  }
  if (ref.kind === 'claim') {
    const eventId = index.claims.get(ref.id)?.eventId;
    return eventId ? (index.events.get(eventId) ?? null) : null;
  }
  return null;
}

const timeOf = (stamp: EventStamp): number => Date.parse(stamp.at);

/** True when `a` happened before `b` (or at the same moment, for `inclusive`). */
function precedes(a: EventStamp, b: EventStamp, inclusive: boolean): boolean {
  const dt = timeOf(a) - timeOf(b);
  if (dt !== 0) return dt < 0;
  return inclusive ? a.sequence <= b.sequence : a.sequence < b.sequence;
}

function checkItemAnchors(output: unknown, vctx: ValidationContext): OutputIssue[] {
  const anchor = AGENT_CATALOG[vctx.agent].itemAnchor;
  if (!anchor || !isRecord(output)) return [];
  const items = output[anchor.arrayKey];
  if (!Array.isArray(items)) return [];
  const { index } = vctx.built;
  const issues: OutputIssue[] = [];
  items.forEach((raw, i) => {
    if (!isRecord(raw)) return;
    const base = `${anchor.arrayKey}[${i}]`;
    const refs = collectCitations(raw);
    let anchorStamp: EventStamp | null = null;
    if (anchor.source === 'event' && typeof raw.eventId === 'string') {
      anchorStamp = index.events.get(raw.eventId) ?? null;
    } else if (anchor.source === 'claim' && typeof raw.claimId === 'string') {
      const eventId = index.claims.get(raw.claimId)?.eventId;
      anchorStamp = eventId ? (index.events.get(eventId) ?? null) : null;
    }
    if (!anchorStamp) return;
    for (const ref of refs) {
      if (anchor.source === 'event' && ref.field === 'eventId') continue;
      const stamp = stampOf(ref, index);
      if (stamp && !precedes(stamp, anchorStamp, anchor.inclusive)) {
        issues.push({
          kind: 'temporal',
          code: 'after_decision_moment',
          path: `${base}.${ref.path}`,
          message: `Cited ${ref.kind} "${safeId(ref.id)}" was not yet known at the moment the item is anchored to.`,
        });
      }
    }
  });
  return issues;
}

/**
 * Nothing cited or asserted may come from after the boundary, and the final resolution must not
 * influence a pre-resolution task (FR-CF-02). Post-hoc agents have no boundary to violate.
 */
export function checkTemporal(output: unknown, vctx: ValidationContext): OutputIssue[] {
  if (AGENT_CATALOG[vctx.agent].temporalMode !== 'pre_resolution') return [];
  const issues: OutputIssue[] = [];
  const guard = vctx.leakGuard;
  const { index } = vctx.built;

  if (guard) {
    for (const ref of collectCitations(output)) {
      const isEvent = ref.kind === 'event' || ref.kind === 'anchor_event';
      const future =
        (isEvent && guard.futureEventIds.has(ref.id) && !index.anchors.has(ref.id)) ||
        (ref.kind === 'evidence' && guard.futureEvidenceIds.has(ref.id));
      if (future && issues.length < MAX_ISSUES) {
        issues.push({
          kind: 'temporal',
          code: 'future_reference',
          path: ref.path,
          message: `Cited ${ref.kind === 'evidence' ? 'evidence' : 'event'} "${safeId(ref.id)}" comes from after the temporal boundary.`,
        });
      }
    }
    const texts = collectTexts(output);
    const haystack = texts
      .map((t) => t.text)
      .join('\n')
      .toLowerCase();
    const leaked = [...guard.futureTokens].filter((token) => haystack.includes(token));
    if (leaked.length > 0) {
      issues.push({
        kind: 'temporal',
        code: 'future_identifier',
        path: '$',
        message: `The output uses ${leaked.length} identifier(s) that first appear after the boundary or only in the final resolution.`,
      });
    }
    const copied = texts.find((t) =>
      [...wordShingles(t.text, SHINGLE_SIZE)].some((s) => guard.futureShingles.has(s)),
    );
    if (copied) {
      issues.push({
        kind: 'temporal',
        code: 'verbatim_future_text',
        path: copied.path,
        message:
          'The output repeats wording that appears only after the boundary or in the final resolution.',
      });
    }
  }
  issues.push(...checkItemAnchors(output, vctx));
  return issues.slice(0, MAX_ISSUES);
}
