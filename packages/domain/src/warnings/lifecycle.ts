import { z } from 'zod';
import {
  IsoTimestampSchema,
  type CaseWarning,
  type Priority,
  type WarningCategory,
} from '@caseguard/schemas';
import { metaOf, type EngineContext } from '../engine/context';
import { stableId } from '../util/ids';
import { compareIso } from '../util/time';
import { isAfter, isEngineerStep, stampOf } from './helpers';
import { resolutionReason, ruleKindOf } from './rules';
import type { Checkpoint, WarningCandidate, WarningDismissal, WarningTransition } from './types';

export const WarningDismissalSchema = z.object({
  dedupeKey: z.string().min(1).max(300),
  by: z.string().min(1).max(120),
  at: IsoTimestampSchema,
  reason: z.string().min(5).max(500),
});

/** Mutable lifecycle bookkeeping of one replay (always created per call; there is no shared state). */
export interface LifecycleState {
  /** Warnings by fingerprint: the dedupe key, with "#n" for the n-th occurrence after the first. */
  warnings: Map<string, CaseWarning>;
  occurrences: Map<string, number>;
  /** Base dedupe keys that were dismissed: they are never re-raised. */
  dismissedBases: Set<string>;
  suppressedLogged: Set<string>;
  applied: Set<string>;
  transitions: WarningTransition[];
}

export const baseKeyOf = (fingerprint: string): string => fingerprint.replace(/#\d+$/, '');

export function createLifecycleState(): LifecycleState {
  return {
    warnings: new Map(),
    occurrences: new Map(),
    dismissedBases: new Set(),
    suppressedLogged: new Set(),
    applied: new Set(),
    transitions: [],
  };
}

/** Rebuilds the bookkeeping from stored warnings so a single checkpoint can continue their lifecycle. */
export function lifecycleFrom(previous: readonly CaseWarning[]): LifecycleState {
  const state = createLifecycleState();
  for (const warning of previous) {
    state.warnings.set(warning.fingerprint, warning);
    const base = baseKeyOf(warning.fingerprint);
    const n = Number(/#(\d+)$/.exec(warning.fingerprint)?.[1] ?? 1);
    state.occurrences.set(base, Math.max(state.occurrences.get(base) ?? 0, n));
    if (warning.state === 'dismissed') state.dismissedBases.add(base);
  }
  return state;
}

const PRIORITY_ORDER: Record<Priority, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const CATEGORY_ORDER: Record<WarningCategory, number> = {
  evidence: 0,
  troubleshooting: 1,
  scoping: 2,
  communication: 3,
  closure: 4,
};
const STATE_ORDER: Record<CaseWarning['state'], number> = { open: 0, dismissed: 1, resolved: 2 };

/** Stable ranking: open first, then priority, category, age and key; rank 1 is shown first. */
export function rankWarnings(warnings: readonly CaseWarning[]): CaseWarning[] {
  const sorted = [...warnings].sort(
    (a, b) =>
      STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
      PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
      CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category] ||
      compareIso(a.raisedAt, b.raisedAt) ||
      (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0),
  );
  return sorted.map((warning, i) => ({ ...warning, rank: i + 1 }));
}

function setWarning(
  state: LifecycleState,
  warning: CaseWarning,
  transition: Omit<WarningTransition, 'warningId' | 'dedupeKey'>,
): void {
  state.warnings.set(warning.fingerprint, warning);
  state.transitions.push({ ...transition, dedupeKey: warning.fingerprint, warningId: warning.id });
}

function resolve(
  state: LifecycleState,
  warning: CaseWarning,
  at: string,
  reason: string,
  kind: 'resolved' | 'superseded',
): void {
  setWarning(
    state,
    { ...warning, state: 'resolved', resolvedAt: at, resolvedReason: reason },
    { at, kind, detail: reason },
  );
}

/** Applies dismissals made at or before `cutoff` to open warnings (a dismissal needs a reason). */
export function applyDismissals(
  state: LifecycleState,
  dismissals: readonly WarningDismissal[],
  cutoff: string,
): void {
  for (const d of dismissals) {
    const id = `${d.dedupeKey}@${d.at}`;
    if (state.applied.has(id) || isAfter(d.at, cutoff)) continue;
    const warning = state.warnings.get(d.dedupeKey);
    if (!warning || warning.state !== 'open' || isAfter(warning.raisedAt, d.at)) continue;
    state.applied.add(id);
    state.dismissedBases.add(baseKeyOf(warning.fingerprint));
    setWarning(
      state,
      { ...warning, state: 'dismissed', dismissal: { by: d.by, at: d.at, reason: d.reason } },
      { at: d.at, kind: 'dismissed', detail: d.reason },
    );
  }
}

function build(candidate: WarningCandidate, occurrence: number, ctx: EngineContext): CaseWarning {
  const fingerprint =
    occurrence === 1 ? candidate.dedupeKey : `${candidate.dedupeKey}#${occurrence}`;
  return {
    ...metaOf(ctx),
    id: stableId('wrn', ctx.caseId, fingerprint),
    caseId: ctx.caseId,
    analysisRunId: ctx.runId,
    ruleId: candidate.ruleId,
    category: candidate.category,
    priority: candidate.priority,
    rank: 1,
    title: candidate.title,
    message: candidate.message,
    suggestedAction: candidate.suggestedAction,
    evidence: candidate.evidence,
    fingerprint,
    raisedAt: candidate.raisedAt,
    resolvedAt: null,
    resolvedReason: null,
    state: 'open',
    dismissal: null,
  };
}

/**
 * Moves every warning to its state at one checkpoint: dismissals are applied, open warnings whose
 * condition no longer holds are resolved, and new conditions are raised once (deduplicated by key,
 * never re-raised after a dismissal, superseding lower tiers).
 */
export function advanceLifecycle(input: {
  state: LifecycleState;
  cp: Checkpoint;
  candidates: readonly WarningCandidate[];
  dismissals: readonly WarningDismissal[];
  ctx: EngineContext;
}): void {
  const { state, cp, candidates, dismissals, ctx } = input;
  applyDismissals(state, dismissals, cp.now);

  const present = new Set(candidates.map((c) => c.dedupeKey));
  for (const warning of [...state.warnings.values()]) {
    if (warning.state !== 'open') continue;
    const base = baseKeyOf(warning.fingerprint);
    if (ruleKindOf(warning.ruleId) === 'state') {
      const successor = candidates.find((c) => c.supersedes.includes(base));
      if (successor) {
        resolve(
          state,
          warning,
          cp.now,
          `Superseded by a more severe warning (“${successor.title}”) raised at ${stampOf(successor.raisedAt)}.`,
          'superseded',
        );
      } else if (!present.has(base)) {
        resolve(state, warning, cp.now, resolutionReason(warning.ruleId, cp), 'resolved');
      }
      continue;
    }
    const subject = base.slice(base.indexOf('|') + 1);
    const trigger = cp.indexOf(subject);
    const next = cp.events.findIndex((e, i) => i > trigger && isEngineerStep(e));
    if (trigger >= 0 && next > trigger) {
      resolve(
        state,
        warning,
        cp.now,
        `The decision point has passed: the next step was recorded at ${stampOf(cp.events[next]?.timestamp ?? cp.now)}. The finding stays in the quality review.`,
        'resolved',
      );
    }
  }

  for (const candidate of candidates) {
    const base = candidate.dedupeKey;
    const count = state.occurrences.get(base) ?? 0;
    if (state.dismissedBases.has(base)) {
      if (!state.suppressedLogged.has(base)) {
        state.suppressedLogged.add(base);
        state.transitions.push({
          at: cp.now,
          dedupeKey: base,
          warningId: stableId('wrn', ctx.caseId, base),
          kind: 'suppressed',
          detail:
            'The condition still holds but the warning was dismissed with a reason; it is not raised again unless the situation worsens.',
        });
      }
      continue;
    }
    const current = count <= 1 ? base : `${base}#${count}`;
    const existing = state.warnings.get(current);
    if (count > 0 && existing?.state === 'open') continue;
    // Event-bound findings never fire twice; a state condition that cleared and returned is a new occurrence.
    if (count > 0 && candidate.kind === 'nudge') continue;
    const occurrence = count + 1;
    const created = build(candidate, occurrence, ctx);
    state.occurrences.set(base, occurrence);
    setWarning(state, created, {
      at: candidate.raisedAt,
      kind: 'raised',
      detail: candidate.title,
    });
    for (const lower of candidate.supersedes) {
      for (const warning of state.warnings.values()) {
        if (warning.state === 'open' && baseKeyOf(warning.fingerprint) === lower) {
          resolve(
            state,
            warning,
            cp.now,
            `Superseded by a more severe warning (“${candidate.title}”) raised at ${stampOf(candidate.raisedAt)}.`,
            'superseded',
          );
        }
      }
    }
  }
}
