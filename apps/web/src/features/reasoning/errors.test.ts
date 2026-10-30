import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api/errors';
import {
  explainJobStartFailure,
  explainReviewFailure,
  isFourEyesRefusal,
  isJobActive,
  isVersionConflict,
} from './errors';

const fourEyes = new ApiError({
  status: 403,
  code: 'forbidden',
  reason: 'separation_of_duties',
  title: 'Forbidden',
  message: 'A different person has to take this step.',
});
const plainForbidden = new ApiError({
  status: 403,
  code: 'forbidden',
  title: 'Forbidden',
  message: 'Four-eyes: separation_of_duties.',
});
const stale = new ApiError({
  status: 409,
  code: 'version_conflict',
  title: 'Version conflict',
  message: 'Whatever the wording is.',
});
const jobActive = new ApiError({
  status: 409,
  code: 'conflict',
  reason: 'job_active',
  title: 'Conflict',
  message: 'Another job is running.',
});
const plainConflict = new ApiError({
  status: 409,
  code: 'conflict',
  title: 'Conflict',
  message: 'This scenario cannot be accepted. It did not pass the temporal leak check.',
});

describe('API conditions are recognised by their stable token, never by the message', () => {
  it('knows a four-eyes refusal by reason separation_of_duties', () => {
    expect(isFourEyesRefusal(fourEyes)).toBe(true);
    expect(isFourEyesRefusal(plainForbidden)).toBe(false);
    expect(isFourEyesRefusal(stale)).toBe(false);
  });

  it('knows a stale record by the code version_conflict', () => {
    expect(isVersionConflict(stale)).toBe(true);
    expect(isVersionConflict(plainConflict)).toBe(false);
    expect(isVersionConflict(jobActive)).toBe(false);
  });

  it('knows a running job by reason job_active', () => {
    expect(isJobActive(jobActive)).toBe(true);
    expect(isJobActive(plainConflict)).toBe(false);
    expect(isJobActive(fourEyes)).toBe(false);
    expect(isJobActive(new Error('job_active'))).toBe(false);
  });
});

describe('what a reviewer is told when a decision is refused', () => {
  it('explains a stale path and says nothing was recorded', () => {
    expect(explainReviewFailure(stale)).toMatch(
      /changed after you opened it.*nothing was recorded.*newest version is shown now/,
    );
    expect(explainReviewFailure(stale)).not.toContain('Whatever the wording is.');
  });

  it('explains the four-eyes rule and adds the API explanation', () => {
    const text = explainReviewFailure(fourEyes);
    expect(text).toContain('needs a second person');
    expect(text).toContain('Ask another reviewer');
    expect(text.endsWith('A different person has to take this step.')).toBe(true);
  });

  it('does not repeat a title as if it were an explanation', () => {
    const bare = new ApiError({
      status: 403,
      code: 'forbidden',
      reason: 'separation_of_duties',
      title: 'Forbidden',
    });
    expect(explainReviewFailure(bare).endsWith('accept or reject this path.')).toBe(true);
  });

  it('shows the API explanation for a refused acceptance and the role message for a plain 403', () => {
    expect(explainReviewFailure(plainConflict)).toBe(plainConflict.message);
    expect(explainReviewFailure(plainForbidden)).toBe('Your role does not allow this.');
  });

  it('falls back to the common description for anything else', () => {
    expect(
      explainReviewFailure(new ApiError({ status: 500, code: 'internal_error', title: 'Error' })),
    ).toBe('The server had a problem handling the request. Retry in a moment.');
    expect(explainReviewFailure(new Error('boom'))).toBe('boom');
  });
});

describe('what is said when a background job cannot start', () => {
  it('names the job that is already running', () => {
    expect(explainJobStartFailure(jobActive, 'simulation')).toMatch(
      /Simulated paths are already being generated for this case\. Wait for that job to finish/,
    );
    expect(explainJobStartFailure(jobActive, 'extraction')).toMatch(
      /A skill is already being extracted for this case\. Wait for that job to finish/,
    );
    expect(explainJobStartFailure(jobActive, 'simulation')).not.toContain('Another job');
  });

  it('shows the API reasons for any other conflict and the common description otherwise', () => {
    expect(explainJobStartFailure(plainConflict, 'simulation')).toBe(plainConflict.message);
    expect(explainJobStartFailure(fourEyes, 'extraction')).toBe('Your role does not allow this.');
  });
});
