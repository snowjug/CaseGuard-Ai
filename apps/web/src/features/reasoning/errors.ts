import { isRateLimited } from '../../components/case/as-of';
import { describeError, isApiError, type ApiError } from '../../lib/api/errors';

/**
 * The stable conditions the API names on a failure (`ApiError.reason`, or `ApiError.code` for a stale record) that the
 * reasoning pages handle on purpose. A condition is recognised by its token, never by the wording of the message. The
 * empty earlier-views budget (429 with the reason `engine_budget`) is recognised by the shared `isRateLimited` of the
 * case pages, so every page treats it the same way.
 */

/** The four-eyes rule refused the step: 403 `forbidden` with the reason `separation_of_duties`. */
export function isFourEyesRefusal(error: unknown): error is ApiError {
  return isApiError(error) && error.reason === 'separation_of_duties';
}

/** The record changed since it was read: 409 `version_conflict`. */
export function isVersionConflict(error: unknown): error is ApiError {
  return isApiError(error) && error.code === 'version_conflict';
}

/** A job of this kind is already running: 409 `conflict` with the reason `job_active`. */
export function isJobActive(error: unknown): error is ApiError {
  return isApiError(error) && error.reason === 'job_active';
}

/** The API's own explanation, when it gave one beyond the title, for the end of a sentence of ours. */
function detailOf(error: ApiError): string {
  return error.message && error.message !== error.title ? ` ${error.message}` : '';
}

/** What to tell a reviewer whose accept or reject was refused, and what to do next. Nothing was recorded in any case. */
export function explainReviewFailure(error: unknown): string {
  if (isVersionConflict(error)) {
    return 'This path changed after you opened it (a new analysis, or another reviewer), so nothing was recorded. The newest version is shown now: check it, then decide again.';
  }
  if (isFourEyesRefusal(error)) {
    return `The four-eyes rule needs a second person to make this decision, so it was not recorded. Ask another reviewer to accept or reject this path.${detailOf(error)}`;
  }
  if (isApiError(error) && error.code === 'conflict') {
    return error.message;
  }
  return describeError(error);
}

/**
 * What to tell a reviewer whose action-ranking override was refused. The one condition handled on purpose is an empty
 * earlier-views budget (429 `engine_budget`, with `Retry-After`): recording an override on an earlier ranking needs that
 * ranking computed, which is metered unless the window was already opened. The 429 comes before any work, so nothing was
 * recorded; the person is told how long to wait.
 */
export function explainOverrideFailure(error: unknown): string {
  if (isRateLimited(error)) {
    const seconds =
      error.retryAfterMs === undefined ? null : Math.max(1, Math.ceil(error.retryAfterMs / 1000));
    return `Computing earlier views is limited to keep the service responsive, so the override could not be recorded just now and nothing was recorded. ${seconds === null ? 'Try again in a moment.' : `Try again in ${seconds} s.`}`;
  }
  return describeError(error);
}

/** What to tell someone whose request to start a background job was refused. */
export function explainJobStartFailure(error: unknown, job: 'simulation' | 'extraction'): string {
  if (isJobActive(error)) {
    return job === 'simulation'
      ? 'Simulated paths are already being generated for this case. Wait for that job to finish, then generate again if a strategy is still missing.'
      : 'A skill is already being extracted for this case. Wait for that job to finish: the draft then appears in the SkillDNA library.';
  }
  if (isApiError(error) && error.code === 'conflict') return error.message;
  return describeError(error);
}
