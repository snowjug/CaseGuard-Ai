import { isRecord } from '../text';
import type { ProposalIssue } from '../types';

/** Bases only the engine may use: a measurement, or an estimate the deterministic engine computed. */
const ENGINE_ONLY_BASES: ReadonlySet<string> = new Set(['measured', 'deterministic_estimate']);

/**
 * A counterfactual from a model rests on the model's own estimate or on an illustration, never on a measurement or on
 * the engine's estimate. Claiming one of those is an overclaim, reported before the schema is consulted (which would
 * only say "value not allowed").
 */
export function checkModelBasisOverclaim(raw: unknown): ProposalIssue[] {
  if (!isRecord(raw) || raw.type !== 'counterfactual') return [];
  const basis = raw.basis;
  if (typeof basis === 'string' && ENGINE_ONLY_BASES.has(basis)) {
    return [
      {
        code: 'model_basis_overclaim',
        path: 'basis',
        message:
          'A model may only estimate or illustrate a counterfactual; a measured or engine-estimated basis is not its to claim.',
      },
    ];
  }
  return [];
}
