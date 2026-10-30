import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api/errors';
import { explainFailure, failureText, needsReload } from './failure';

function problem(
  status: number,
  code: string,
  options: { reason?: string; message?: string; retryAfterMs?: number } = {},
): ApiError {
  return new ApiError({
    status,
    code,
    title: 'Problem',
    message: options.message ?? 'The API explains it here.',
    ...(options.reason ? { reason: options.reason } : {}),
    ...(options.retryAfterMs !== undefined ? { retryAfterMs: options.retryAfterMs } : {}),
  });
}

describe('[FR-QR-10] Explaining a refused request from the problem code and reason', () => {
  it('recognises a four-eyes refusal by its reason and keeps the API wording after the explanation', () => {
    const failure = explainFailure(
      problem(403, 'forbidden', {
        reason: 'separation_of_duties',
        message: 'The approver must differ from the creator of the skill.',
      }),
    );
    expect(failure.kind).toBe('four_eyes');
    expect(failure.reason).toBe('separation_of_duties');
    expect(failure.title).toBe('Another person has to do this step');
    expect(failureText(failure)).toContain('the four-eyes rule');
    expect(failureText(failure)).toContain(
      'The API said: The approver must differ from the creator of the skill.',
    );
    expect(needsReload(failure)).toBe(false);
  });

  it('never reads the wording of a message to decide what a refusal is', () => {
    // The wording says "must differ" but the API sent no reason: it is an ordinary permission refusal.
    const wordingOnly = explainFailure(
      problem(403, 'forbidden', { message: 'The approver must differ from the creator.' }),
    );
    expect(wordingOnly.kind).toBe('permission');
    const otherReason = explainFailure(
      problem(403, 'forbidden', { reason: 'case_export_disabled' }),
    );
    expect(otherReason.kind).toBe('permission');

    // The same for a conflict and a gate: only the code and the reason count.
    const conflict = explainFailure(
      problem(409, 'conflict', { message: 'That transition is not allowed from here.' }),
    );
    expect(conflict.kind).toBe('conflict');
    const gate = explainFailure(
      problem(412, 'precondition_failed', {
        message: 'A run on a single case does not satisfy the gate; a rollback withdrew it.',
      }),
    );
    expect(gate.kind).toBe('gate');
    expect(gate.message).toBe('The step is blocked until its requirement holds.');
  });

  it('explains an illegal lifecycle step and asks for a reload', () => {
    const failure = explainFailure(problem(409, 'conflict', { reason: 'illegal_transition' }));
    expect(failure.kind).toBe('illegal_step');
    expect(failure.message).toContain('already moved on');
    expect(needsReload(failure)).toBe(true);
  });

  it('treats a stale record as such by its code, and asks for a reload', () => {
    const failure = explainFailure(problem(409, 'version_conflict'));
    expect(failure.kind).toBe('stale');
    expect(failure.message).toContain('The page has been refreshed');
    expect(needsReload(failure)).toBe(true);
  });

  it('tells a repeated request still being processed from a conflict, without reloading', () => {
    const failure = explainFailure(problem(409, 'conflict', { reason: 'request_in_progress' }));
    expect(failure.kind).toBe('in_progress');
    expect(failure.message).toContain('so it is not done twice');
    expect(needsReload(failure)).toBe(false);
  });

  it('keeps a plain conflict generic, shows what the API said, and asks for a reload', () => {
    const failure = explainFailure(
      problem(409, 'conflict', { message: 'The skill is no longer available for matching.' }),
    );
    expect(failure.kind).toBe('conflict');
    expect(failureText(failure)).toContain(
      'The API said: The skill is no longer available for matching.',
    );
    expect(needsReload(failure)).toBe(true);
  });

  it('explains what a refused gate needs from the step the person was taking, not from the message', () => {
    const refused = problem(412, 'precondition_failed', { reason: 'gate_failed' });
    expect(explainFailure(refused).message).toBe(
      'The step is blocked until its requirement holds.',
    );

    const lifecycle = explainFailure(refused, { lifecycleStep: true });
    expect(lifecycle.kind).toBe('gate');
    expect(lifecycle.message).toContain('A run on one case does not satisfy the gate');
    expect(lifecycle.message).toContain('only a full run counts');
    expect(lifecycle.message).not.toContain('rollback');

    const rollback = explainFailure(refused, { rollback: true });
    expect(rollback.message).toContain('can only restore a version that was once approved');
    expect(rollback.message).toContain('the current one was built from');
    expect(rollback.message).toContain('an earlier rollback withdrew');
    expect(rollback.message).not.toContain('one case');
    expect(needsReload(lifecycle)).toBe(false);
  });

  it('says why a throttled recomputation was refused and for how long to wait', () => {
    const budget = explainFailure(
      problem(429, 'rate_limited', { reason: 'engine_budget', retryAfterMs: 7000 }),
    );
    expect(budget.kind).toBe('throttled');
    expect(budget.retryAfterSeconds).toBe(7);
    expect(budget.message).toContain('has to recompute this view');
    expect(budget.message).toContain('Views already computed stay available');
    expect(budget.message).toContain('Try again in 7 seconds.');

    const plain = explainFailure(problem(429, 'rate_limited', { retryAfterMs: 1000 }));
    expect(plain.message).toBe(
      'The server is limiting how fast this can be asked for. Try again in 1 second.',
    );
    const unknownWait = explainFailure(problem(429, 'rate_limited'));
    expect(unknownWait.retryAfterSeconds).toBeNull();
    expect(unknownWait.message).toContain('Wait a moment, then try again.');
  });

  it('rounds a fraction of a second up and never says zero seconds', () => {
    expect(
      explainFailure(problem(429, 'rate_limited', { retryAfterMs: 1200 })).retryAfterSeconds,
    ).toBe(2);
    expect(
      explainFailure(problem(429, 'rate_limited', { retryAfterMs: 10 })).retryAfterSeconds,
    ).toBe(1);
  });

  it('explains the other refusals by status, and an unreachable API', () => {
    expect(explainFailure(problem(404, 'not_found')).kind).toBe('not_found');
    expect(explainFailure(problem(400, 'validation_failed')).kind).toBe('invalid');
    expect(explainFailure(problem(422, 'validation_failed')).kind).toBe('invalid');
    expect(explainFailure(problem(500, 'internal')).kind).toBe('other');
    expect(explainFailure(problem(0, 'network_error')).kind).toBe('unavailable');
    expect(explainFailure(problem(502, 'upstream_unavailable')).kind).toBe('unavailable');
  });

  it('wraps anything that is not an API error', () => {
    const failure = explainFailure(new Error('Boom'));
    expect(failure.kind).toBe('other');
    expect(failure.message).toBe('Boom');
    expect(failure.reason).toBeNull();
    expect(explainFailure('not an error').message).toBe('Something unexpected happened.');
  });

  it('lists the field issues after the explanation, at most three', () => {
    const error = new ApiError({
      status: 422,
      code: 'validation_failed',
      title: 'Invalid',
      message: 'Some fields are wrong.',
      issues: [
        { path: 'reason', message: 'Too short' },
        { path: 'expectedVersion', message: 'Required' },
        { path: 'toState', message: 'Unknown' },
        { path: 'extra', message: 'Never shown' },
      ],
    });
    const text = failureText(explainFailure(error));
    expect(text).toContain('reason: Too short');
    expect(text).toContain('toState: Unknown');
    expect(text).not.toContain('Never shown');
  });
});
