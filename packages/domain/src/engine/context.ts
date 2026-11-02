import type { Evidence, ParticipantRole } from '@caseguard/schemas';
import { CUSTOMER_SIDE_ROLES } from '@caseguard/schemas';
import type { CompiledPack } from '../knowledge/compile';
import { clamp } from '../util/math';
import { earlierPosition, positionsOf } from './responders';
import { MAX_EXCERPT_CHARS, type Observation } from './signals';
import { sourcePointerFor } from './source-ref';
import type { TemporalView } from './temporal';

/** Shared, injected context for every engine function (clock, ids and provenance come from here). */
export interface EngineContext {
  tenantId: string;
  caseId: string;
  runId: string;
  /** ISO timestamp used for createdAt/updatedAt/extractedAt. Injected for determinism. */
  now: string;
  createdBy: string;
  /** Seed for every stochastic step (uncertainty bands, rollouts). */
  seed: string;
}

export const metaOf = (ctx: EngineContext) => ({
  tenantId: ctx.tenantId,
  createdAt: ctx.now,
  updatedAt: ctx.now,
  createdBy: ctx.createdBy,
  version: 1,
});

export const isCustomerSide = (role: ParticipantRole): boolean =>
  CUSTOMER_SIDE_ROLES.includes(role);

const STRENGTH_CONFIDENCE = { strong: 0.9, moderate: 0.75, weak: 0.6 } as const;
const DIAGNOSTIC_OUTPUT_TYPES: ReadonlySet<string> = new Set([
  'diagnostic_result',
  'log_sample',
  'query_output',
]);

/** Converts detected observations into Evidence records (every observation, belief-affecting or not). */
export function buildEvidence(
  view: TemporalView,
  pack: CompiledPack,
  observations: readonly Observation[],
  ctx: EngineContext,
): Evidence[] {
  const evidence: Evidence[] = [];
  const positions = positionsOf(view.events);
  for (const obs of observations) {
    const signal = pack.signals.get(obs.signalId);
    const event = view.events[obs.eventIndex];
    if (!signal || !event) continue;
    const customerSide = isCustomerSide(event.participantRole);
    // Only an earlier event can have been answered: a forward reference must not let later events
    // change how this one is classified (prefix and full analyses have to agree).
    const parentPosition = earlierPosition(positions, event.inResponseTo, obs.eventIndex);
    const parent = parentPosition === null ? undefined : view.events[parentPosition];
    const answersEngineer =
      parent !== undefined &&
      !isCustomerSide(parent.participantRole) &&
      (parent.action !== null || parent.type === 'engineer_email');
    const diagnosticOutput = DIAGNOSTIC_OUTPUT_TYPES.has(event.type);
    // A customer relaying requested diagnostic output is diagnostic evidence; spontaneous statements are reports.
    const category =
      customerSide &&
      !diagnosticOutput &&
      !(answersEngineer && signal.category === 'diagnostic_evidence')
        ? 'customer_reported'
        : signal.category;
    evidence.push({
      ...metaOf(ctx),
      id: obs.id,
      caseId: ctx.caseId,
      analysisRunId: ctx.runId,
      signalId: signal.id,
      label: signal.label,
      summary: signal.description,
      kind: signal.evidenceKind,
      strength: signal.strength,
      category,
      eventId: event.id,
      sourceRef: {
        eventId: event.id,
        sourceId: event.sourceId,
        pointer: sourcePointerFor(event, obs.field),
        ...(obs.field !== null && obs.start !== null && obs.end !== null
          ? { field: obs.field, start: obs.start, end: obs.end }
          : {}),
        excerpt: obs.excerpt.slice(0, MAX_EXCERPT_CHARS),
      },
      excerpt: obs.excerpt.slice(0, MAX_EXCERPT_CHARS),
      observedAt: event.timestamp,
      confidence: clamp(
        STRENGTH_CONFIDENCE[signal.strength] * (obs.method === 'structured' ? 1 : 0.95),
        0,
        1,
      ),
      method: obs.method === 'structured' ? 'structured' : 'pattern',
    });
  }
  return evidence;
}
