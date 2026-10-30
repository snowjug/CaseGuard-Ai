import type { OutputIssue, ValidationContext } from './types';
import { collectCitations, type CitationKind, type CitationRef } from './walk';

const MAX_ISSUES = 30;

/** Ids are echoed in messages only when they are known to be ours (supplied context or pack ids). */
export function safeId(id: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(id) ? id : '[invalid-id]';
}

function isKnown(ref: CitationRef, vctx: ValidationContext): boolean {
  const { index } = vctx.built;
  switch (ref.kind) {
    case 'event':
      return index.events.has(ref.id);
    case 'anchor_event':
      return index.anchors.has(ref.id) || index.events.has(ref.id);
    case 'evidence':
      return index.evidence.has(ref.id);
    case 'claim':
      return index.claims.has(ref.id);
    case 'hypothesis':
      return index.hypotheses.has(ref.id);
    case 'action':
      return index.actions.has(ref.id);
    case 'requirement':
      return index.requirements.has(ref.id);
    case 'signal':
      return index.signals.has(ref.id);
  }
}

const KIND_LABEL: Record<CitationKind, string> = {
  event: 'event',
  anchor_event: 'decision event',
  evidence: 'evidence',
  claim: 'claim',
  hypothesis: 'hypothesis',
  action: 'action',
  requirement: 'requirement',
  signal: 'signal',
};

/** Ids that exist only after the boundary are reported by the temporal validator, not here. */
function isFutureId(ref: CitationRef, vctx: ValidationContext): boolean {
  const guard = vctx.leakGuard;
  if (!guard) return false;
  if (ref.kind === 'event' || ref.kind === 'anchor_event') return guard.futureEventIds.has(ref.id);
  if (ref.kind === 'evidence') return guard.futureEvidenceIds.has(ref.id);
  return false;
}

export interface CitationCheck {
  issues: OutputIssue[];
  total: number;
  valid: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A proposal must answer the request it was written for: the same decision point and the same
 * strategy. Both are checked against the context the model was given, so a proposal computed for
 * another request (for example one served from a cache) is rejected however well it is formed.
 */
function checkRequestBinding(
  output: unknown,
  refs: readonly CitationRef[],
  vctx: ValidationContext,
): OutputIssue[] {
  if (vctx.agent !== 'counterfactual_simulator') return [];
  const { focus } = vctx.built.context;
  const issues: OutputIssue[] = [];
  const forkEvent = focus.forkEventId;
  if (typeof forkEvent === 'string') {
    for (const ref of refs.filter((r) => r.field === 'forkEventId')) {
      if (ref.id !== forkEvent) {
        issues.push({
          kind: 'citation',
          code: 'wrong_anchor',
          path: ref.path,
          message: 'The proposal is anchored on a different decision point than the one requested.',
        });
      }
    }
  }
  const strategy = focus.strategy;
  if (typeof strategy === 'string' && isRecord(output) && output.strategy !== strategy) {
    issues.push({
      kind: 'citation',
      code: 'strategy_mismatch',
      path: 'strategy',
      message: 'The proposal was written for a different strategy than the one requested.',
    });
  }
  return issues;
}

/** Every cited id must be one that was supplied in the prompt context. */
export function checkCitations(output: unknown, vctx: ValidationContext): CitationCheck {
  const refs = collectCitations(output);
  const issues: OutputIssue[] = [];
  let valid = 0;
  for (const ref of refs) {
    if (isKnown(ref, vctx)) {
      valid++;
      continue;
    }
    if (isFutureId(ref, vctx)) continue;
    if (issues.length < MAX_ISSUES) {
      issues.push({
        kind: 'citation',
        code: `unknown_${ref.kind}`,
        path: ref.path,
        message: `A cited ${KIND_LABEL[ref.kind]} id was not supplied in the context.`,
      });
    }
  }
  issues.push(...checkRequestBinding(output, refs, vctx));
  return { issues, total: refs.length, valid };
}
