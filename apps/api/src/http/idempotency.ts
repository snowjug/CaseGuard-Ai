import type { FastifyReply, FastifyRequest } from 'fastify';
import { IdSchema } from '@caseguard/schemas';
import { canonicalJson, sha256Hex } from '@caseguard/security';
import { ConflictError, IdempotencyConflictError, ValidationFailedError } from '../errors';
import type { RequestContext } from './request-context';

const IDEMPOTENCY_HEADER = 'idempotency-key';
const REPLAY_HEADER = 'idempotent-replayed';
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

/** The validated `Idempotency-Key` header, or null when the client sent none. */
export function readIdempotencyKey(request: FastifyRequest): string | null {
  const raw = request.headers[IDEMPOTENCY_HEADER];
  if (raw === undefined) return null;
  const value = Array.isArray(raw) ? (raw.length === 1 ? raw[0] : undefined) : raw;
  if (value === undefined || !KEY_PATTERN.test(value)) {
    throw new ValidationFailedError('The Idempotency-Key header is not valid', [
      {
        path: 'header.idempotency-key',
        message: 'Use 8 to 128 URL-safe characters (letters, digits, . _ : -)',
      },
    ]);
  }
  return value;
}

/**
 * Keys are private to the caller that chose them, so another user of the same tenant can neither
 * replay a stored response nor block a key by registering it first with a different request.
 * The user id is hashed to keep the stored scope short and free of identifiers.
 */
export function idempotencyScope(routeId: string, userId: string): string {
  return `${routeId}:${sha256Hex(userId).slice(0, 24)}`;
}

/** Fastify hands routes without a schema objects with a custom prototype, which `canonicalJson` refuses. */
function plainCopy(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? { ...value } : value;
}

export interface HashedRequest {
  readonly routeId: string;
  readonly params: unknown;
  readonly query: unknown;
  readonly body: unknown;
  readonly file: { readonly sha256: string; readonly name: string } | undefined;
}

/** Fingerprint of everything that decides what a request does; the same key must carry the same one. */
export function hashRequest(request: HashedRequest): string {
  try {
    return sha256Hex(
      canonicalJson({
        routeId: request.routeId,
        params: plainCopy(request.params),
        query: plainCopy(request.query),
        body: request.body,
        file: request.file ?? null,
      }),
    );
  } catch (error) {
    // `canonicalJson` refuses nesting that no real payload has; that is the client's doing.
    if (error instanceof RangeError) {
      throw new ValidationFailedError('The request body is nested too deeply', [
        { path: 'body', message: 'Nesting is limited to 200 levels' },
      ]);
    }
    throw error;
  }
}

export interface IdempotentRun {
  readonly key: string;
  readonly scope: string;
  readonly status: number;
  readonly requestHash: string;
  /** The route's path parameters: a `caseId` among them links the stored response to that case. */
  readonly params?: unknown;
  readonly execute: () => Promise<unknown>;
}

export interface IdempotentOutcome {
  readonly body: unknown;
  /** The stored response of an earlier identical request; the handler did not run. */
  readonly replayed: boolean;
}

function idField(value: unknown, name: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const found = (value as Record<string, unknown>)[name];
  return typeof found === 'string' && IdSchema.safeParse(found).success ? found : null;
}

/**
 * The case a response is about: the `caseId` path parameter, else the case of an ingest result or the
 * case of a job. A stored response can quote case content, so the data tier links it to the case and
 * erases it with the case.
 */
export function linkedCaseId(params: unknown, body: unknown): string | null {
  return (
    idField(params, 'caseId') ??
    idField((body as { case?: unknown } | null)?.case, 'id') ??
    idField((body as { job?: unknown } | null)?.job, 'caseId') ??
    idField(body, 'caseId')
  );
}

/**
 * Runs `execute` at most once per key. The first request reserves the key, runs, and stores its
 * response; an identical retry gets that response back, a different request with the same key is
 * refused, and a concurrent duplicate is told to wait.
 */
export async function runIdempotent(
  ctx: RequestContext,
  response: FastifyReply,
  run: IdempotentRun,
): Promise<IdempotentOutcome> {
  const begin = await ctx.repos.idempotency.begin(run.key, run.scope, run.requestHash);
  switch (begin.state) {
    case 'replay':
      void response.header(REPLAY_HEADER, 'true');
      return { body: begin.response, replayed: true };
    case 'conflict':
      throw new IdempotencyConflictError();
    case 'in_progress':
      throw new ConflictError('A request with this Idempotency-Key is still being processed', {
        reason: 'request_in_progress',
      });
    case 'new':
      break;
  }

  let body: unknown;
  try {
    body = await run.execute();
  } catch (error) {
    // The attempt failed, so free the key and let the client retry.
    await ctx.repos.idempotency.release(run.key, run.scope).catch((releaseError: unknown) => {
      ctx.logger.warn({ err: releaseError }, 'could not release idempotency key');
    });
    throw error;
  }

  try {
    await ctx.repos.idempotency.complete(run.key, run.scope, run.status, body, {
      caseId: linkedCaseId(run.params, body),
    });
  } catch (error) {
    // The work is already committed. Failing the request would invite a retry that repeats it, so the
    // client gets the real result; the key stays reserved until its reservation expires, and the
    // fault is loud in the logs and metrics.
    ctx.logger.error(
      { err: error, event: 'idempotency.complete_failed' },
      'could not store the response for idempotent replay',
    );
    ctx.metrics.recordError('idempotency', 'complete_failed');
  }
  return { body, replayed: false };
}
