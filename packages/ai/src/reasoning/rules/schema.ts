import { findProhibitedFields, type AnyProposal, type FindingType } from '@caseguard/schemas';
import { isRecord, sanitisePath } from '../text';
import type { ProposalIssue } from '../types';
import { parseProposal, pathOf, type ZodIssue } from './parse';

/**
 * An issue the other rules already explain under their own code: a size problem (`excessive_output`), a missing
 * citation (`missing_evidence`), a field only the server sets (`prohibited_field`), a basis only the engine may use
 * (`model_basis_overclaim`). It is not reported a second time as a schema error.
 */
function isExplainedElsewhere(issue: ZodIssue, raw: unknown): boolean {
  if (issue.code === 'too_big') return true;
  const last = issue.path[issue.path.length - 1];
  if (issue.code === 'unrecognized_keys') {
    const names = issue.keys;
    return (
      names.length > 0 &&
      findProhibitedFields(Object.fromEntries(names.map((k) => [k, 1]))).length === names.length
    );
  }
  if (last === 'evidence' && (issue.code === 'invalid_type' || issue.code === 'too_small')) {
    return true;
  }
  if (last === 'basis' && isRecord(raw)) {
    return raw.basis === 'measured' || raw.basis === 'deterministic_estimate';
  }
  return false;
}

/**
 * The proposal has to match the strict schema of its type: every key present, no key unknown, every value one the
 * schema allows. Violations another rule reports under its own code (size, a missing citation, a server-only field, an
 * engine-only basis) are left to that rule. Returns the parsed proposal when it matches.
 */
export function checkSchema(
  type: FindingType,
  raw: unknown,
): { issues: ProposalIssue[]; parsed: AnyProposal | null } {
  const result = parseProposal(type, raw);
  const issues = result.issues
    .filter((issue) => !isExplainedElsewhere(issue, raw))
    .slice(0, 5)
    .map((issue) => ({
      code: 'schema' as const,
      path: sanitisePath(pathOf(issue.path)),
      message: 'The proposal does not match its schema.',
    }));
  return { issues, parsed: result.parsed };
}
