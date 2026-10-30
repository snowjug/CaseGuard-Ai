import { isApiError, type ApiIssue } from '../../lib/api/errors';

export type FailureKind =
  | 'four_eyes'
  | 'permission'
  | 'stale'
  | 'illegal_step'
  | 'conflict'
  | 'in_progress'
  | 'gate'
  | 'invalid'
  | 'throttled'
  | 'not_found'
  | 'unavailable'
  | 'other';

export interface ExplainedFailure {
  kind: FailureKind;
  /** Short headline. */
  title: string;
  /** Plain-language explanation that ends with what the person can do next. */
  message: string;
  /** What the API said, verbatim: the domain messages name states, versions and permissions, never case content. */
  apiDetail: string | null;
  /** The stable `reason` token the API sent with the problem (for example `separation_of_duties`), or null. */
  reason: string | null;
  /** Seconds to wait before trying again (`Retry-After`), or null. */
  retryAfterSeconds: number | null;
  issues: readonly ApiIssue[];
}

/**
 * What the person was doing, for the explanations the API's `reason` token cannot carry: a refused gate (`gate_failed`)
 * says that a requirement is unmet, and what the requirement is depends on the step. The caller knows the step, so
 * nothing here reads the wording of a message.
 */
export interface FailureContext {
  /** A lifecycle step (moving a skill on, or approving a proposed version): its gate is about approvals and full runs. */
  lifecycleStep?: boolean;
  /** A rollback: its gate is about which version can come back. */
  rollback?: boolean;
}

const GATE_LIFECYCLE =
  ' A step can need earlier approvals and passed full runs of the current content. A run on one case does not satisfy the gate: only a full run counts. The Validation tab shows what has been run.';
const GATE_ROLLBACK =
  ' A rollback can only restore a version that was once approved and that the current one was built from (a version that an earlier rollback withdrew has to be proposed again as a new version), and the restored content must still hold the validations this stage requires.';

/** Whole seconds to wait, rounded up and never below one. */
function secondsOf(retryAfterMs: number | undefined): number | null {
  return retryAfterMs === undefined ? null : Math.max(1, Math.ceil(retryAfterMs / 1000));
}

/**
 * Turns any failure of an API call into something a person can act on. Refusals of governed steps (permission,
 * four-eyes, stale record, illegal step, unmet gate, throttling) each get their own plain-language explanation next to
 * the API's own wording. A refusal is recognised by the problem's `code`, status and stable `reason` token, never by
 * the wording of its message (the API sends `separation_of_duties`, `illegal_transition`, `gate_failed`,
 * `request_in_progress` and `engine_budget` for exactly this purpose).
 */
export function explainFailure(error: unknown, context: FailureContext = {}): ExplainedFailure {
  if (!isApiError(error)) {
    return {
      kind: 'other',
      title: 'Something went wrong',
      message: error instanceof Error ? error.message : 'Something unexpected happened.',
      apiDetail: null,
      reason: null,
      retryAfterSeconds: null,
      issues: [],
    };
  }
  const detail = error.message && error.message !== error.title ? error.message : null;
  const base = {
    apiDetail: detail,
    reason: error.reason ?? null,
    retryAfterSeconds: secondsOf(error.retryAfterMs),
    issues: error.issues,
  };
  const wait = base.retryAfterSeconds;

  if (error.status === 429 || error.code === 'rate_limited') {
    const retry =
      wait === null
        ? 'Wait a moment, then try again.'
        : `Try again in ${wait} ${wait === 1 ? 'second' : 'seconds'}.`;
    return {
      ...base,
      kind: 'throttled',
      title: 'Too many requests right now',
      message:
        error.reason === 'engine_budget'
          ? `The server has to recompute this view because it has not computed it before, and it limits how many of those it does in a short time. Views already computed stay available. ${retry}`
          : `The server is limiting how fast this can be asked for. ${retry}`,
    };
  }
  if (error.isNetwork || error.isUnavailable || error.isMisconfigured || error.isTimeout) {
    return {
      ...base,
      kind: 'unavailable',
      title: 'The CaseGuard API could not be reached',
      message: 'Nothing was changed. Check that the API server is running, then try again.',
    };
  }
  if (error.status === 403) {
    if (error.reason === 'separation_of_duties') {
      return {
        ...base,
        kind: 'four_eyes',
        title: 'Another person has to do this step',
        message:
          'Approvals are kept independent (the four-eyes rule): whoever created a skill, proposed a change or approved an earlier stage cannot also approve this one. Ask a colleague with the right role to take this step.',
      };
    }
    return {
      ...base,
      kind: 'permission',
      title: 'Your role cannot do this',
      message:
        'Your role does not include the permission this step needs. Ask someone with the right role, or switch to a persona that has it.',
    };
  }
  if (error.code === 'version_conflict') {
    return {
      ...base,
      kind: 'stale',
      title: 'Someone changed this first',
      message:
        'The record was changed after you opened it, so your decision was not applied. The page has been refreshed: look at the latest state, then try again.',
    };
  }
  if (error.status === 409 || error.code === 'conflict') {
    if (error.reason === 'illegal_transition') {
      return {
        ...base,
        kind: 'illegal_step',
        title: 'That step is not allowed from here',
        message:
          "The skill's current state does not allow this step, for example because it has already moved on. Look at the latest state before trying again.",
      };
    }
    if (error.reason === 'request_in_progress') {
      return {
        ...base,
        kind: 'in_progress',
        title: 'The same request is still running',
        message:
          'The server is still working on this request. Wait a moment and look at the page before trying again, so it is not done twice.',
      };
    }
    return {
      ...base,
      kind: 'conflict',
      title: 'That step is not available now',
      message: 'It cannot be done from the current state. Reload to see what is possible now.',
    };
  }
  if (error.status === 412 || error.code === 'precondition_failed') {
    return {
      ...base,
      kind: 'gate',
      title: 'A requirement is not met yet',
      message: `The step is blocked until its requirement holds.${context.lifecycleStep ? GATE_LIFECYCLE : ''}${context.rollback ? GATE_ROLLBACK : ''}`,
    };
  }
  if (error.status === 404) {
    return {
      ...base,
      kind: 'not_found',
      title: 'It no longer exists',
      message: 'The record could not be found. It may have been removed; reload the page.',
    };
  }
  if (error.status === 400 || error.status === 422) {
    return {
      ...base,
      kind: 'invalid',
      title: 'The request was not accepted',
      message: 'Check what you entered, then try again.',
    };
  }
  return {
    ...base,
    kind: 'other',
    title: 'The request failed',
    message: 'The server could not complete the request. Try again in a moment.',
  };
}

/** True when the page was probably showing an out-of-date record, so it should reload before the person tries again. */
export function needsReload(failure: ExplainedFailure): boolean {
  return failure.kind === 'stale' || failure.kind === 'conflict' || failure.kind === 'illegal_step';
}

/** One sentence for a dialog or a toast: the explanation first, then the API's own wording when it adds something. */
export function failureText(failure: ExplainedFailure): string {
  const parts: string[] = [failure.message];
  if (failure.apiDetail) parts.push(`The API said: ${failure.apiDetail}`);
  for (const issue of failure.issues.slice(0, 3)) parts.push(`${issue.path}: ${issue.message}`);
  return parts.join(' ');
}
