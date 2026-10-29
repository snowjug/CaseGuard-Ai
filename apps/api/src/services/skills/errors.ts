import type { ExtractionRefusal, SkillError } from '@caseguard/domain';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  PreconditionFailedError,
  ValidationFailedError,
} from '../../errors';

const MAX_ISSUES = 50;

type Issue = { path: string; message: string };

/** One problem entry per refusal reason, so the caller sees every reason the engine gave. */
export function refusalIssues(refusals: readonly ExtractionRefusal[]): Issue[] {
  return refusals
    .flatMap((refusal) =>
      refusal.reasons.map((message) => ({
        path: refusal.scenarioId === null ? 'scenario' : `scenario.${refusal.scenarioId}`,
        message,
      })),
    )
    .slice(0, MAX_ISSUES);
}

/** The 422 problem for an extraction the engine refused, listing its reasons. */
export function extractionRefusedError(
  refusals: readonly ExtractionRefusal[],
): ValidationFailedError {
  return new ValidationFailedError(
    'SkillDNA cannot be extracted: the engine refused the scenario. See the listed reasons.',
    refusalIssues(refusals),
  );
}

function isRefusal(value: unknown): value is ExtractionRefusal {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { scenarioId?: unknown; reasons?: unknown };
  return (
    (candidate.scenarioId === null || typeof candidate.scenarioId === 'string') &&
    Array.isArray(candidate.reasons) &&
    candidate.reasons.every((reason) => typeof reason === 'string')
  );
}

/**
 * Maps a domain refusal to the application error with the status and Problem Details code the domain
 * documents in `SKILL_ERROR_HTTP`. Domain messages name states, versions and permissions only, never
 * case content, so they are safe to show.
 */
export function skillErrorToAppError(error: SkillError): AppError {
  switch (error.code) {
    case 'forbidden':
    case 'separation_of_duties':
      return new ForbiddenError(error.message);
    case 'version_conflict':
      return new AppError('version_conflict', 409, error.message);
    case 'illegal_transition':
    case 'conflict':
      return new ConflictError(error.message);
    case 'gate_failed':
      return new PreconditionFailedError(error.message);
    case 'not_found':
      return new AppError('not_found', 404, error.message);
    case 'validation_failed':
      return new ValidationFailedError(error.message);
    case 'extraction_refused': {
      const raw: unknown = error.details.refusals;
      const refusals = Array.isArray(raw) ? raw.filter(isRefusal) : [];
      return new ValidationFailedError(error.message, refusalIssues(refusals));
    }
  }
}
