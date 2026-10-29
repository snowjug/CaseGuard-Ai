import type {
  Claim,
  DecisionFork,
  DiagnosticAction,
  Evidence,
  HypothesisEvidenceLink,
  MissingEvidence,
} from '@caseguard/schemas';
import { analyzeView, compareIso, type ViewAnalysis } from '@caseguard/domain';
import type { TaskBase } from '../agents/tasks';
import type { EventStamp } from './types';

export interface ScopedMissingEvidence extends MissingEvidence {
  /** True when the requirement was already relevant at the boundary and still unmet then. */
  openAtBoundary: boolean;
}

/** Every analysis artefact restricted to what was known inside the task's temporal view. */
export interface ScopedAnalysis {
  eventIds: ReadonlySet<string>;
  stamps: ReadonlyMap<string, EventStamp>;
  evidence: Evidence[];
  claims: Claim[];
  links: HypothesisEvidenceLink[];
  actions: DiagnosticAction[];
  forks: DecisionFork[];
  missing: ScopedMissingEvidence[];
  /** Posterior, observations and satisfied requirements derived from the view alone. */
  state: ViewAnalysis;
}

/**
 * The single place where a (possibly wider) deterministic analysis is narrowed to the task's
 * boundary. Artefacts are kept only when the event they come from is inside the view, so a
 * pre-resolution prompt can never contain information from later in the case.
 */
export function scopeAnalysis(task: TaskBase): ScopedAnalysis {
  const { view, analysis, pack, ctx } = task;
  const eventIds = new Set(view.events.map((e) => e.id));
  const stamps = new Map(view.events.map((e) => [e.id, { at: e.timestamp, sequence: e.sequence }]));
  const evidence = analysis.evidence.filter((e) => eventIds.has(e.eventId));
  const evidenceIds = new Set(evidence.map((e) => e.id));
  return {
    eventIds,
    stamps,
    evidence,
    claims: analysis.claims.filter((c) => c.eventId !== null && eventIds.has(c.eventId)),
    links: analysis.links.filter((l) => evidenceIds.has(l.evidenceId)),
    actions: analysis.actions.filter((a) => eventIds.has(a.eventId)),
    forks: analysis.forks.filter((f) => eventIds.has(f.eventId)),
    missing: analysis.missing.map((m) => {
      const relevantCmp = compareIso(m.firstRelevantAt, view.asOf);
      const relevant = view.mode === 'before' ? relevantCmp < 0 : relevantCmp <= 0;
      const resolvedInView = m.resolvedByEventId !== null && eventIds.has(m.resolvedByEventId);
      return { ...m, openAtBoundary: relevant && !resolvedInView };
    }),
    state: analyzeView(view, pack, ctx.caseId),
  };
}
