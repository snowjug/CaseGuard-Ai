import { ApiError, describeError } from '../api/errors';
import { retryAdvice } from '../api/reason';

/** The refusals the demo endpoints send as a 409 (`conflict`), told in this app's words and keyed by the API's `reason`. */
function demoConflict(reason: string | undefined): string | null {
  switch (reason) {
    case 'job_active':
      return 'A job is still queued or running in this workspace. Wait until it has finished, then try again. Nothing was changed.';
    case 'not_a_demo_tenant':
      return 'Demo data can only be seeded or reset in a synthetic demo tenant, and this workspace is not one. Nothing was changed.';
    case 'personas_unavailable':
      return 'The demo story needs its synthetic personas (engineer, reviewer, curator and administrator) in this workspace, and they are missing or have been changed. Nothing was changed.';
    default:
      return null;
  }
}

/**
 * The message a demo action's confirmation dialog shows when the API refuses it. It switches on the API's stable
 * `reason` (and `code`), not on its wording; a refusal with a reason this app does not know yet falls back to the
 * API's own sentence, so nothing is hidden.
 */
export function explainDemoError(error: unknown, fallback = 'The request failed.'): Error {
  if (!(error instanceof ApiError)) return new Error(fallback);
  if (error.code === 'conflict') {
    const text = demoConflict(error.reason);
    if (text !== null) return new Error(text);
  }
  if (error.code === 'rate_limited') {
    const lead =
      error.reason === 'engine_budget'
        ? 'Too many views were recomputed in a short time. Views that are already computed stay available.'
        : 'Too many requests were made in a short time.';
    return new Error(`${lead} ${retryAdvice(error)}`);
  }
  return new Error(describeError(error));
}
