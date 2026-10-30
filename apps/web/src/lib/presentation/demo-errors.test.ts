import { describe, expect, it } from 'vitest';
import { ApiError, type ApiErrorInit } from '../api/errors';
import { explainDemoError } from './demo-errors';

const refusal = (init: Partial<ApiErrorInit> = {}) =>
  new ApiError({ status: 409, code: 'conflict', title: 'Conflict', ...init });

describe('[FR-DEMO-10] a refused demo action is explained by the API reason', () => {
  it.each([
    ['job_active', /A job is still queued or running/],
    ['not_a_demo_tenant', /only be seeded or reset in a synthetic demo tenant/],
    ['personas_unavailable', /needs its synthetic personas/],
  ])("%s is told in the app's own words, whatever the message says", (reason, expected) => {
    const text = explainDemoError(
      refusal({ reason, message: 'Wording the UI must not depend on' }),
    ).message;
    expect(text).toMatch(expected);
    expect(text).not.toContain('Wording the UI');
    expect(text).toMatch(/Nothing was changed\.$/);
  });

  it('shows the API sentence when a conflict has no reason, or one this app does not know yet', () => {
    expect(explainDemoError(refusal({ message: 'A sentence from the API.' })).message).toBe(
      'A sentence from the API.',
    );
    expect(
      explainDemoError(refusal({ reason: 'something_new', message: 'A newer refusal.' })).message,
    ).toBe('A newer refusal.');
  });

  it('only reads a reason on the error code it belongs to', () => {
    const forbidden = new ApiError({
      status: 403,
      code: 'forbidden',
      reason: 'job_active',
      title: 'Forbidden',
    });
    expect(explainDemoError(forbidden).message).toBe('Your role does not allow this.');
  });

  it('asks for a pause on a rate limit, using Retry-After when the server sent one', () => {
    const limited = (init: Partial<ApiErrorInit> = {}) =>
      new ApiError({ status: 429, code: 'rate_limited', title: 'Too many requests', ...init });
    expect(explainDemoError(limited({ retryAfterMs: 12_000 })).message).toBe(
      'Too many requests were made in a short time. Try again in about 12 seconds.',
    );
    expect(explainDemoError(limited({ retryAfterMs: 400 })).message).toBe(
      'Too many requests were made in a short time. Try again in about 1 second.',
    );
    expect(explainDemoError(limited({ reason: 'engine_budget' })).message).toBe(
      'Too many views were recomputed in a short time. Views that are already computed stay available. Try again in a moment.',
    );
  });

  it('keeps the plain explanations for everything else', () => {
    expect(
      explainDemoError(new ApiError({ status: 500, code: 'internal', title: 'Internal' })).message,
    ).toMatch(/server had a problem/);
    expect(explainDemoError(new Error('boom'), 'The reset failed.').message).toBe(
      'The reset failed.',
    );
    expect(explainDemoError('nope').message).toBe('The request failed.');
  });
});
