import { describe, expect, it } from 'vitest';
import { ProblemSchema } from '@caseguard/schemas';
import {
  AuthenticationError,
  AuthorizationError,
  RedactionIncompleteError,
  TenantIsolationError,
} from '@caseguard/security';
import {
  AppError,
  BudgetExceededError,
  ConflictError,
  ForbiddenError,
  IdempotencyConflictError,
  NotAnalysedError,
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
    const error = Object.assign(new Error('Request body is too large'), {
      statusCode: 413,
      code: 'FST_ERR_CTP_BODY_TOO_LARGE',
    });
    const result = convert(error);
    expect(result.status).toBe(413);
    expect(result.problem.code).toBe('payload_too_large');
    expect(result.problem.detail).toBe('Request body is too large');
  });

  it('keeps the status of a multipart client error but not of other framework faults', () => {
    const tooMany = Object.assign(new Error('reach parts limit'), {
      statusCode: 413,
      code: 'FST_PARTS_LIMIT',
    });
    expect(convert(tooMany).status).toBe(413);
    const framework = Object.assign(new Error('the file buffer was not found'), {
      statusCode: 500,
      code: 'FST_FILE_BUFFER_NOT_FOUND',
    });
    const result = convert(framework);
    expect(result.status).toBe(500);
    expect(JSON.stringify(result.problem)).not.toContain('buffer');
  });

  it.each([401, 403, 404, 409, 429])(
    'does not let a non-Fastify error with status %i choose the response',
    (statusCode) => {
      const upstream = Object.assign(
        new Error('AADSTS700016: Application with identifier was not found in tenant'),
        { statusCode, name: 'SomeSdkError' },
      );
      const result = convert(upstream);
      expect(result.status).toBe(500);
      expect(result.denied).toBe(false);
      expect(result.unexpected).toBe(true);
      expect(JSON.stringify(result.problem)).not.toContain('AADSTS');
    },
  );

  it('reports an Azure SDK failure as an unavailable dependency, not as the caller being refused', () => {
    const sdk = Object.assign(new Error('AuthorizationFailure: this request is not authorized'), {
      name: 'RestError',
      statusCode: 403,
      code: 'AuthorizationFailure',
    });
    const result = convert(sdk);
    expect(result.status).toBe(503);
    expect(result.problem.code).toBe('provider_unavailable');
    expect(result.denied).toBe(false);
    expect(result.unexpected).toBe(true);
    expect(JSON.stringify(result.problem)).not.toContain('AuthorizationFailure');
  });

  it.each([
    ['a refused connection', 'ECONNREFUSED'],
    ['a timed-out connection', 'ETIMEDOUT'],
    ['an unknown host', 'ENOTFOUND'],
    ['a PostgreSQL connection failure', '08006'],
    ['a PostgreSQL server shutdown', '57P01'],
    ['too many PostgreSQL connections', '53300'],
  ])('reports %s as a dependency outage', (_label, code) => {
    const result = convert(
      Object.assign(new Error('connect failed to db.internal:5432'), { code }),
    );
    expect(result.status).toBe(503);
    expect(result.unexpected).toBe(true);
    expect(JSON.stringify(result.problem)).not.toContain('db.internal');
  });

  it('does not mistake an ordinary database error for an outage', () => {
    const unique = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
    });
    expect(convert(unique).status).toBe(500);
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

  describe('reason: a stable token for conditions a client may handle on purpose', () => {
    it.each([
      [
        'a four-eyes refusal',
        new ForbiddenError('The publisher must differ from the creator', {
          reason: 'separation_of_duties',
        }),
        403,
        'forbidden',
        'separation_of_duties',
      ],
      [
        'a reference already in use',
        new ConflictError('Reference taken', { reason: 'reference_in_use' }),
        409,
        'conflict',
        'reference_in_use',
      ],
      [
        'the engine budget',
        new RateLimitedError(4, 'Too many views', 'engine_budget'),
        429,
        'rate_limited',
        'engine_budget',
      ],
      ['a case that was never analysed', new NotAnalysedError(), 409, 'conflict', 'not_analysed'],
      [
        'a refused file',
        new UnsafeContentError('The file was refused.', { reason: 'file_refused' }),
        422,
        'unsafe_content',
        'file_refused',
      ],
      [
        'a redaction that could not be completed',
        new RedactionIncompleteError([
          { code: 'pattern_timeout', label: 'Order number', message: 'Timed out' },
        ]),
        422,
        'unsafe_content',
        'redaction_incomplete',
      ],
    ])('reports %s', (_name, error, status, code, reason) => {
      const result = convert(error);
      expect(result.status).toBe(status);
      expect(result.problem).toMatchObject({ code, reason });
      expect(ProblemSchema.safeParse(result.problem).success).toBe(true);
    });

    it('keeps the retry delay of the engine budget while naming it', () => {
      const result = convert(new RateLimitedError(4.2, 'Too many views', 'engine_budget'));
      expect(result.headers['retry-after']).toBe('5');
      expect(result.problem.reason).toBe('engine_budget');
    });

    it.each([
      ['no reason at all', new ConflictError('Plain')],
      ['a reason that is free text', new ConflictError('Text', { reason: 'Not a token at all' })],
      ['a reason that is too long', new ConflictError('Long', { reason: 'a'.repeat(60) })],
      ['a reason that is not a string', new ConflictError('Number', { reason: 42 })],
      ['a reason with an upper-case letter', new ConflictError('Case', { reason: 'Reference' })],
    ])('leaves %s out of the body', (_name, error) => {
      const result = convert(error);
      expect(result.problem).not.toHaveProperty('reason');
      expect(ProblemSchema.safeParse(result.problem).success).toBe(true);
    });
  });
});
