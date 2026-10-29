import { describe, expect, it } from 'vitest';
import { ProblemSchema } from '@caseguard/schemas';
import { AuthenticationError, AuthorizationError, TenantIsolationError } from '@caseguard/security';
import {
  AppError,
  BudgetExceededError,
  ConflictError,
  ForbiddenError,
  IdempotencyConflictError,
  NotFoundError,
  NotImplementedError,
  PayloadTooLargeError,
  ProviderUnavailableError,
  RateLimitedError,
  UnsafeContentError,
  UnsupportedMediaTypeError,
  ValidationFailedError,
  VersionConflictError,
} from '../src/errors';
import { toProblem } from '../src/http/problem';

const requestId = 'req_01TESTREQUEST';
const convert = (error: unknown) => toProblem(error, { requestId });

describe('toProblem', () => {
  it.each([
    [new NotFoundError('Case', 'case_1'), 404, 'not_found'],
    [new ConflictError('Already exists'), 409, 'conflict'],
    [new VersionConflictError('Skill', 2, 3), 409, 'version_conflict'],
    [new ForbiddenError(), 403, 'forbidden'],
    [new IdempotencyConflictError(), 422, 'idempotency_conflict'],
    [new UnsafeContentError('Refused'), 422, 'unsafe_content'],
    [new PayloadTooLargeError(), 413, 'payload_too_large'],
    [new UnsupportedMediaTypeError(), 415, 'unsupported_media_type'],
    [new BudgetExceededError('Daily token budget reached'), 429, 'budget_exceeded'],
    [new ProviderUnavailableError(), 503, 'provider_unavailable'],
    [new NotImplementedError('Thing'), 501, 'not_implemented'],
  ])('maps %o to status %i and code %s', (error, status, code) => {
    const result = convert(error);
    expect(result.status).toBe(status);
    expect(result.problem.code).toBe(code);
    expect(result.problem.type).toBe(`urn:caseguard:problem:${code}`);
    expect(result.problem.correlationId).toBe(requestId);
    expect(result.unexpected).toBe(false);
    expect(ProblemSchema.safeParse(result.problem).success).toBe(true);
  });

  it('lists the validation issues of a ValidationFailedError', () => {
    const result = convert(
      new ValidationFailedError('Invalid', [
        { path: 'body.title', message: 'Too short' },
        { path: 'body.severity', message: 'Unknown value' },
      ]),
    );
    expect(result.status).toBe(422);
    expect(result.problem.errors).toEqual([
      { path: 'body.title', message: 'Too short' },
      { path: 'body.severity', message: 'Unknown value' },
    ]);
  });

  it('caps the number and size of reported issues', () => {
    const issues = Array.from({ length: 250 }, (_, index) => ({
      path: `body.field${index}`,
      message: 'x'.repeat(2000),
    }));
    const { problem } = convert(new ValidationFailedError('Invalid', issues));
    expect(problem.errors).toHaveLength(100);
    expect(problem.errors?.[0]?.message.length).toBeLessThanOrEqual(500);
    expect(ProblemSchema.safeParse(problem).success).toBe(true);
  });

  it('tells rate-limited callers when to retry', () => {
    const result = convert(new RateLimitedError(12.2));
    expect(result.status).toBe(429);
    expect(result.headers['retry-after']).toBe('13');
  });

  it('asks unauthenticated callers for a bearer token without saying why they failed', () => {
    const result = convert(new AuthenticationError('invalid_signature'));
    expect(result.status).toBe(401);
    expect(result.denied).toBe(true);
    expect(result.headers['www-authenticate']).toMatch(/^Bearer /);
    expect(JSON.stringify(result.problem)).not.toContain('invalid_signature');
    expect(result.problem.detail).toBe('Authentication failed');
  });

  it('treats permission and tenant violations as denials', () => {
    expect(convert(new AuthorizationError()).denied).toBe(true);
    const tenant = convert(new TenantIsolationError('tenant_a', 'tenant_b'));
    expect(tenant.status).toBe(403);
    expect(tenant.denied).toBe(true);
    // The tenant ids are kept off the wire entirely.
    expect(JSON.stringify(tenant.problem)).not.toContain('tenant_a');
    expect(JSON.stringify(tenant.problem)).not.toContain('tenant_b');
  });

  it('turns Fastify client errors into problems with their own safe message', () => {
    const error = Object.assign(new Error('Request body is too large'), { statusCode: 413 });
    const result = convert(error);
    expect(result.status).toBe(413);
    expect(result.problem.code).toBe('payload_too_large');
    expect(result.problem.detail).toBe('Request body is too large');
  });

  it('never echoes the message of an unexpected error', () => {
    const secret = 'postgres://svc:hunter2@db.internal:5432/app';
    const result = convert(new Error(`connect ECONNREFUSED ${secret}`));
    expect(result.status).toBe(500);
    expect(result.unexpected).toBe(true);
    expect(result.problem.code).toBe('internal');
    expect(JSON.stringify(result.problem)).not.toContain('hunter2');
    expect(JSON.stringify(result.problem)).not.toContain('ECONNREFUSED');
    expect(result.problem.correlationId).toBe(requestId);
  });

  it('survives values that are not errors at all', () => {
    for (const value of [null, undefined, 'boom', 42, { statusCode: 'nope' }]) {
      const result = convert(value);
      expect(result.status).toBe(500);
      expect(ProblemSchema.safeParse(result.problem).success).toBe(true);
    }
  });

  it('keeps AppError details out of the problem body', () => {
    const error = new AppError('conflict', 409, 'Visible message', { internalPath: '/srv/data' });
    const result = convert(error);
    expect(JSON.stringify(result.problem)).not.toContain('/srv/data');
  });
});
