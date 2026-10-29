import type { CaseEvent, EvidenceLink, Priority, WarningCategory } from '@caseguard/schemas';
import { eventLink, evidenceLink, truncate } from '../quality/links';
import { formatUtcStamp } from '../util/time';
import { describeStep } from './suggest';
import type { Checkpoint, SuggestedStep, WarningCandidate } from './types';

const ENGINEER_STEP_TYPES: ReadonlySet<string> = new Set([
  'engineer_email',
  'engineer_action',
  'case_note',
  'escalation',
  'resolution_note',
  'validation_result',
]);

/** A step the support engineer took (not a tool output, a system message or someone else's note). */
export const isEngineerStep = (event: CaseEvent): boolean =>
  (event.participantRole === 'support_engineer' ||
    event.participantRole === 'escalation_engineer') &&
  ENGINEER_STEP_TYPES.has(event.type);

export const stampOf = (iso: string): string => formatUtcStamp(iso);

/** ISO instant in the same style as case events (no fractional seconds when they are zero). */
export const isoAt = (ms: number): string => new Date(ms).toISOString().replace(/\.000Z$/, 'Z');

/** Whether instant `a` is strictly later than `b` (compared as time, not as text). */
export const isAfter = (a: string, b: string): boolean => Date.parse(a) > Date.parse(b);

export const isBefore = (a: string, b: string): boolean => Date.parse(a) < Date.parse(b);

export const latestEvent = (cp: Checkpoint): CaseEvent | undefined => cp.events[cp.index];

/** Index of the latest event that carries an engineer belief statement (hedged or definitive). */
export function latestBeliefIndex(cp: Checkpoint): number {
  let latest = -1;
  for (const claim of cp.claims) {
    if (!claim.ruleId.startsWith('statement.') || claim.eventId === null) continue;
    latest = Math.max(latest, cp.indexOf(claim.eventId));
  }
  return latest;
}

export function eventLinks(cp: Checkpoint, ids: readonly string[], max = 4): EvidenceLink[] {
  return ids.slice(0, max).flatMap((id) => {
    const event = cp.events[cp.indexOf(id)];
    return event ? [eventLink(event)] : [];
  });
}

export const requirementLink = (cp: Checkpoint, id: string): EvidenceLink =>
  evidenceLink('requirement', id, cp.pack.requirements.get(id)?.label);

export interface CandidateInput {
  ruleId: string;
  subject: string;
  category: WarningCategory;
  priority: Priority;
  title: string;
  message: string;
  /** The safer next step, rendered with its estimated cost, effort and risk. */
  step: SuggestedStep | null;
  /** Lead-in for the rendered step (also the whole text when there is no step and no fallback). */
  lead: string;
  /** Text used when no pack step applies. */
  fallback?: string;
  evidence: readonly EvidenceLink[];
  raisedAt: string;
  kind: 'state' | 'nudge';
  triggerIndex?: number | null;
  supersedes?: readonly string[];
}

export const dedupeKeyOf = (ruleId: string, subject: string): string => `${ruleId}|${subject}`;

/** Builds a candidate with contract-sized text and the suggestion rendered from the pack step. */
export function candidate(input: CandidateInput): WarningCandidate {
  return {
    ruleId: input.ruleId,
    subject: input.subject,
    dedupeKey: dedupeKeyOf(input.ruleId, input.subject),
    category: input.category,
    priority: input.priority,
    title: truncate(input.title, 200),
    message: truncate(input.message, 800),
    suggestedAction: truncate(
      input.step ? describeStep(input.step, input.lead) : (input.fallback ?? input.lead),
      400,
    ),
    suggestion: input.step,
    evidence: [...input.evidence].slice(0, 10),
    raisedAt: input.raisedAt,
    kind: input.kind,
    triggerIndex: input.triggerIndex ?? null,
    supersedes: [...(input.supersedes ?? [])],
  };
}
