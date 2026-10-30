import { describe, expect, it } from 'vitest';
import { notAnalysedError } from '../../../test/case-fixtures';
import { ApiError, type ApiErrorInit } from '../../lib/api/errors';
import { NOT_ANALYSED_REASON, isNotAnalysedError } from './NotAnalysedState';

/** A 409 conflict the way the API sends one, with the parts a test wants to vary. */
const conflict = (init: Partial<ApiErrorInit> = {}): ApiError =>
  new ApiError({
    status: 409,
    code: 'conflict',
    title: 'Conflict',
    message: 'This case has not been analysed yet. Start an analysis first.',
    ...init,
  });

describe('isNotAnalysedError', () => {
  it('recognises the 409 conflict that carries the not_analysed reason', () => {
    expect(NOT_ANALYSED_REASON).toBe('not_analysed');
    expect(isNotAnalysedError(notAnalysedError())).toBe(true);
    // The token is all that is needed: whatever sentence comes with it, it is the same condition.
    expect(isNotAnalysedError(conflict({ reason: 'not_analysed', message: 'Refused.' }))).toBe(
      true,
    );
  });

  it('does not read the wording: the same sentence without the token is an ordinary conflict', () => {
    expect(isNotAnalysedError(conflict())).toBe(false);
    expect(
      isNotAnalysedError(
        conflict({
          message:
            'The stored analysis no longer matches the engine output for this fork (the governed configuration changed). Run the analysis again first.',
        }),
      ),
    ).toBe(false);
  });

  it('is not fooled by another reason, another code or another status', () => {
    expect(isNotAnalysedError(conflict({ reason: 'job_active' }))).toBe(false);
    expect(
      isNotAnalysedError(
        conflict({ status: 422, code: 'validation_failed', reason: 'not_analysed' }),
      ),
    ).toBe(false);
    expect(
      isNotAnalysedError(conflict({ status: 403, code: 'forbidden', reason: 'not_analysed' })),
    ).toBe(false);
  });

  it('is false for anything that is not an API error', () => {
    expect(isNotAnalysedError(new Error('This case has not been analysed yet.'))).toBe(false);
    expect(isNotAnalysedError('not_analysed')).toBe(false);
    expect(isNotAnalysedError(null)).toBe(false);
    expect(isNotAnalysedError(undefined)).toBe(false);
  });
});
