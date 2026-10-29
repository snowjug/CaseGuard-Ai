import type { CaseEvent, CaseResolution, Evidence } from '@caseguard/schemas';
import {
  assertPreResolution,
  createTemporalView,
  futureOnlyTokens,
  type CompiledPack,
  type TemporalView,
} from '@caseguard/domain';
import { wordShingles } from '../util/text';
import type { LeakGuard } from './types';

export interface LeakGuardInput {
  /** The full event log (hindsight). Used only to recognise leakage, never rendered into a prompt. */
  events: readonly CaseEvent[];
  resolution: CaseResolution | null;
  /** What the model was allowed to see. */
  view: TemporalView;
  evidence?: readonly Evidence[];
  /** Pack texts are public knowledge and therefore excluded from the "future-only" phrases. */
  pack?: CompiledPack;
}

const SHINGLE_SIZE = 6;

const eventText = (e: CaseEvent): string => `${e.title ?? ''} ${e.body}`;

function packTexts(pack: CompiledPack): string[] {
  const p = pack.pack;
  return [
    p.disclaimer,
    ...p.hypotheses.map((h) => `${h.name} ${h.description}`),
    ...p.actions.map((a) => `${a.label} ${a.description} ${a.safetyNotes ?? ''}`),
    ...p.signals.map((s) => `${s.label} ${s.description} ${s.explanation}`),
    ...p.requirements.map((r) => `${r.label} ${r.description} ${r.askText}`),
  ];
}

/**
 * Builds the set of things that must not appear in a pre-resolution output: ids of records after
 * the boundary, identifiers that first appear after it (or only in the resolution), and verbatim
 * phrases copied from later events or the resolution.
 */
export function buildLeakGuard(input: LeakGuardInput): LeakGuard {
  const { events, resolution, view } = input;
  const visibleIds = new Set(view.events.map((e) => e.id));
  const pre =
    view.resolution === null ? view : createTemporalView(view.events, view.asOf, { mode: 'at' });
  assertPreResolution(pre);

  const resolutionText = resolution
    ? `${resolution.summary} ${resolution.rootCause} ${resolution.workaround ?? ''} ${resolution.permanentFix ?? ''}`
    : '';
  const futureTokens = futureOnlyTokens(events, pre, resolutionText);

  const known = new Set<string>();
  for (const e of view.events)
    for (const s of wordShingles(eventText(e), SHINGLE_SIZE)) known.add(s);
  if (input.pack) {
    for (const t of packTexts(input.pack))
      for (const s of wordShingles(t, SHINGLE_SIZE)) known.add(s);
  }
  const futureShingles = new Set<string>();
  const addFuture = (text: string): void => {
    for (const s of wordShingles(text, SHINGLE_SIZE)) if (!known.has(s)) futureShingles.add(s);
  };
  for (const e of events) if (!visibleIds.has(e.id)) addFuture(eventText(e));
  if (resolutionText) addFuture(resolutionText);

  return {
    futureEventIds: new Set(events.filter((e) => !visibleIds.has(e.id)).map((e) => e.id)),
    futureEvidenceIds: new Set(
      (input.evidence ?? []).filter((e) => !visibleIds.has(e.eventId)).map((e) => e.id),
    ),
    futureTokens,
    futureShingles,
  };
}
