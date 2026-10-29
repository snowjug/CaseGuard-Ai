import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { z } from 'zod';
import type { ProductMetrics } from '@caseguard/observability';
import type { AppConfig } from '@caseguard/config';
import { ROUTES, type RouteId, type RouteSpec } from '@caseguard/schemas';
import {
  AuthenticationError,
  AuthorizationError,
  canonicalJson,
  sha256Hex,
  type AuthContext,
} from '@caseguard/security';
import { setContextValue } from '@caseguard/observability';
import {
  ConflictError,
  IdempotencyConflictError,
  NotImplementedError,
  RateLimitedError,
  UnsupportedMediaTypeError,
  ValidationFailedError,
} from '../errors';
import type { Infrastructure } from '../infrastructure';
import { buildRequestContext } from './context-factory';
import './fastify-types';
import type { RequestContext } from './request-context';
import { toProblem } from './problem';

// ---------------------------------------------------------------- handler typing

type Spec<K extends RouteId> = (typeof ROUTES)[K];

/** The parsed (post-validation) type of a route's `params`, `query` or `body`; `undefined` when absent. */
type ParsedPart<S, Key extends string> = S extends {
  readonly [P in Key]: infer Z extends z.ZodType;
}
  ? z.output<Z>
  : undefined;

export type ParamsOf<K extends RouteId> = ParsedPart<Spec<K>, 'params'>;
export type QueryOf<K extends RouteId> = ParsedPart<Spec<K>, 'query'>;
export type BodyOf<K extends RouteId> = ParsedPart<Spec<K>, 'body'>;
export type ResponseOf<K extends RouteId> = z.output<Spec<K>['response']>;

export interface UploadedFile {
  /** Name sent by the client. Hostile: run it through the security package before storing or echoing. */
  readonly fileName: string;
  readonly mediaType: string | null;
  readonly bytes: Buffer;
  readonly sha256: string;
}

type FileOf<K extends RouteId> =
  Spec<K> extends { readonly multipart: true } ? UploadedFile : undefined;

/** Routes callable without credentials. Their handlers receive a context without a caller or tenant. */
export type PublicRouteId = 'dev.personas';
const PUBLIC_ROUTES: ReadonlySet<RouteId> = new Set<RouteId>(['dev.personas']);

export interface PublicContext {
  readonly requestId: string;
  readonly config: AppConfig;
  readonly logger: FastifyBaseLogger;
  readonly metrics: ProductMetrics;
  readonly now: () => Date;
}

type ContextOf<K extends RouteId> = K extends PublicRouteId ? PublicContext : RequestContext;

export interface RouteCall<K extends RouteId> {
  readonly params: ParamsOf<K>;
  readonly query: QueryOf<K>;
  readonly body: BodyOf<K>;
  /** The single uploaded file of a `multipart` route. */
  readonly file: FileOf<K>;
  readonly ctx: ContextOf<K>;
  /** Validated `Idempotency-Key` header, if the route honours one and the client sent it. */
  readonly idempotencyKey: string | null;
  readonly request: FastifyRequest;
}

const REPLY = Symbol('caseguard.httpReply');

/** A body plus extra response headers (for example `content-disposition` on a download). */
export interface HttpReply<T> {
  readonly [REPLY]: true;
  readonly body: T;
  readonly headers: Readonly<Record<string, string>>;
}

export function reply<T>(body: T, headers: Record<string, string> = {}): HttpReply<T> {
  return { [REPLY]: true, body, headers };
}

function isHttpReply(value: unknown): value is HttpReply<unknown> {
  return typeof value === 'object' && value !== null && REPLY in value;
}

export type RouteHandler<K extends RouteId> = (
  call: RouteCall<K>,
) => Promise<ResponseOf<K> | HttpReply<ResponseOf<K>>>;

/** Handlers keyed by route id. A group of routes exports one of these; the container merges them. */
export type HandlerMap = { readonly [K in RouteId]?: RouteHandler<K> };

/** Merges handler maps and fails loudly when two groups claim the same route. */
export function mergeHandlers(...maps: readonly HandlerMap[]): HandlerMap {
  const merged: Record<string, unknown> = {};
  for (const map of maps) {
    for (const [id, handler] of Object.entries(map)) {
      if (handler === undefined) continue;
      if (id in merged) throw new Error(`Route "${id}" has more than one handler`);
      merged[id] = handler;
    }
  }
  return merged;
}

/** Route ids from the contract that no handler covers. The build-completeness test asserts this is empty. */
export function missingHandlers(handlers: HandlerMap): RouteId[] {
  return (Object.keys(ROUTES) as RouteId[]).filter((id) => handlers[id] === undefined);
}

// ---------------------------------------------------------------- policy tables

/** Routes that start AI-assisted or otherwise expensive work get the stricter per-user limit. */
export const HEAVY_ROUTES: ReadonlySet<RouteId> = new Set<RouteId>([
  'analysis.start',
  'counterfactuals.run',
  'skills.extract',
  'skills.simulationTest',
  'skills.proposeMutation',
  'cases.create',
  'cases.createFromFile',
  'demo.seed',
]);

/** Reads that expose security-relevant data are audited like mutations. */
const AUDITED_READS: ReadonlySet<RouteId> = new Set<RouteId>([
  'governance.audit',
  'governance.users',
]);

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const IDEMPOTENCY_HEADER = 'idempotency-key';
const REPLAY_HEADER = 'idempotent-replayed';

// ---------------------------------------------------------------- binder

export interface BindOptions {
  readonly infra: Infrastructure;
  readonly handlers: HandlerMap;
  /**
   * Fail at start-up when a documented route has no handler. When false, missing routes answer 501
   * (used while a build is incomplete and in focused tests).
   */
  readonly requireComplete: boolean;
}

type AnyCall = RouteCall<RouteId>;
type AnyHandler = (call: AnyCall) => Promise<unknown>;

function firstParam(params: unknown): string | null {
  if (typeof params !== 'object' || params === null) return null;
  for (const value of Object.values(params)) if (typeof value === 'string') return value;
  return null;
}

function caseIdOf(params: unknown): string | null {
  if (typeof params !== 'object' || params === null) return null;
  const value = (params as { caseId?: unknown }).caseId;
  return typeof value === 'string' ? value : null;
}

function readIdempotencyKey(request: FastifyRequest): string | null {
  const raw = request.headers[IDEMPOTENCY_HEADER];
  if (raw === undefined) return null;
  const value = Array.isArray(raw) ? (raw.length === 1 ? raw[0] : undefined) : raw;
  if (value === undefined || !IDEMPOTENCY_KEY.test(value)) {
    throw new ValidationFailedError('The Idempotency-Key header is not valid', [
      {
        path: 'header.idempotency-key',
        message: 'Use 8 to 128 URL-safe characters (letters, digits, . _ : -)',
      },
    ]);
  }
  return value;
}

async function readUpload(request: FastifyRequest, maxBytes: number): Promise<UploadedFile> {
  if (!request.isMultipart()) {
    throw new UnsupportedMediaTypeError(
      'Send multipart/form-data with one file in the "file" field',
    );
  }
  const part = await request.file({ limits: { fileSize: maxBytes, files: 1 } });
  if (part === undefined) {
    throw new ValidationFailedError('No file was uploaded', [
      { path: 'file', message: 'Attach one file in the "file" field' },
    ]);
  }
  if (part.fieldname !== 'file') {
    throw new ValidationFailedError('The file must be sent in the "file" field', [
      { path: part.fieldname.slice(0, 40), message: 'Unexpected field name' },
    ]);
  }
  // `toBuffer` throws a 413 when the part exceeds `fileSize`; the error handler turns it into a problem.
  const bytes = await part.toBuffer();
  return {
    fileName: part.filename,
    mediaType: part.mimetype === '' ? null : part.mimetype,
    bytes,
    sha256: sha256Hex(bytes),
  };
}

function publicContext(infra: Infrastructure, request: FastifyRequest): PublicContext {
  return {
    requestId: request.cg.requestId,
    config: infra.config,
    logger: request.log,
    metrics: infra.metrics,
    now: infra.now,
  };
}

/**
 * Registers every route of the contract. The binder owns the cross-cutting policy so handlers stay
 * small and cannot forget it:
 *
 * - authentication and the route's permission run before the body is parsed;
 * - the handler receives a tenant-bound context; the tenant comes from the credential, never the request;
 * - `Idempotency-Key` is honoured on routes marked `idempotent`;
 * - denied access, server faults and every state-changing request leave an audit event;
 * - request and response bodies are validated against the contract's Zod schemas.
 */
export function registerRoutes(app: FastifyInstance, options: BindOptions): void {
  const { infra, handlers } = options;
  const missing = missingHandlers(handlers);
  if (options.requireComplete && missing.length > 0) {
    throw new Error(`Routes without a handler: ${missing.join(', ')}`);
  }

  const typed = app.withTypeProvider<ZodTypeProvider>();
  const config = infra.config;
  const windowMs = config.limits.rateLimitWindowMs;
  const heavyLimit = app.createRateLimit({
    max: config.limits.rateLimitAiMax,
    timeWindow: windowMs,
    keyGenerator: (request) => {
      const auth = request.cg.auth;
      return auth === null ? `ip:${request.ip}` : `user:${auth.tenantId}:${auth.userId}`;
    },
  });

  for (const [id, spec] of Object.entries(ROUTES) as [RouteId, RouteSpec][]) {
    const handler = handlers[id] as AnyHandler | undefined;
    const isPublic = PUBLIC_ROUTES.has(id);
    const mutating = spec.method !== 'GET';
    const audited = mutating || AUDITED_READS.has(id);
    const status = spec.status ?? 200;

    const authenticate = async (request: FastifyRequest): Promise<void> => {
      request.cg.routeId = id;
      if (isPublic) return;

      let auth: AuthContext;
      try {
        auth = await infra.authenticator.authenticate(request.headers);
      } catch (error) {
        if (error instanceof AuthenticationError) {
          infra.metrics.recordAuthFailure(error.reason);
          request.log.warn(
            { event: 'auth.failure', reason: error.reason, routeId: id },
            'authentication failed',
          );
        }
        throw error;
      }

      request.cg.auth = auth;
      setContextValue('tenantId', auth.tenantId);
      setContextValue('userId', auth.userId);
      const state = request.cg;
      state.ctx = buildRequestContext(infra, {
        requestId: state.requestId,
        auth,
        permission: spec.permission,
        signal: state.abort.signal,
        logger: request.log,
        onAudit: () => {
          state.audited = true;
        },
      });

      if (spec.permission !== null && !auth.permissions.includes(spec.permission)) {
        infra.metrics.recordForbidden(spec.permission);
        await state.ctx.audit({
          action: 'access.denied',
          targetType: 'route',
          targetId: id,
          caseId: caseIdOf(request.params),
          outcome: 'denied',
          details: { routeId: id, method: spec.method, requiredPermission: spec.permission },
        });
        throw new AuthorizationError(undefined, spec.permission);
      }
    };

    const limitHeavy = async (request: FastifyRequest): Promise<void> => {
      const verdict = await heavyLimit(request);
      // `isAllowed: false` only means "counted"; the request is refused once the count passes `max`.
      if (verdict.isAllowed || !verdict.isExceeded) return;
      infra.metrics.recordRateLimitHit('heavy');
      throw new RateLimitedError(verdict.ttlInSeconds);
    };

    const run = async (request: FastifyRequest, response: FastifyReply): Promise<unknown> => {
      if (handler === undefined) throw new NotImplementedError(spec.summary);

      const ctx: RequestContext | PublicContext = isPublic
        ? publicContext(infra, request)
        : (request.cg.ctx as RequestContext);
      const file =
        spec.multipart === true ? await readUpload(request, config.http.uploadMaxBytes) : undefined;
      const idempotencyKey = spec.idempotent === true ? readIdempotencyKey(request) : null;

      const call = {
        params: request.params,
        query: request.query,
        body: request.body,
        file,
        ctx,
        idempotencyKey,
        request,
      } as unknown as AnyCall;

      const execute = async (): Promise<unknown> => {
        const result = await handler(call);
        const extra = isHttpReply(result) ? result.headers : {};
        for (const [name, value] of Object.entries(extra)) void response.header(name, value);
        return isHttpReply(result) ? result.body : result;
      };

      const tenantCtx = isPublic ? null : (ctx as RequestContext);
      let body: unknown;
      if (idempotencyKey !== null && tenantCtx !== null) {
        body = await runIdempotent(tenantCtx, response, {
          key: idempotencyKey,
          scope: id,
          status,
          requestHash: sha256Hex(
            canonicalJson({
              routeId: id,
              params: request.params,
              query: request.query,
              body: request.body,
              file: file === undefined ? null : { sha256: file.sha256, name: file.fileName },
            }),
          ),
          execute,
        });
      } else {
        body = await execute();
      }

      if (tenantCtx !== null && audited && !request.cg.audited) {
        await tenantCtx.audit({
          action: `api.${id}`,
          targetType: 'route',
          targetId: firstParam(request.params),
          caseId: caseIdOf(request.params),
          outcome: 'success',
          details: { routeId: id, method: spec.method },
        });
      }
      return body;
    };

    typed.route({
      method: spec.method,
      url: spec.path,
      config: { routeId: id },
      schema: {
        tags: [...spec.tags],
        summary: spec.summary,
        ...(spec.params ? { params: spec.params } : {}),
        ...(spec.query ? { querystring: spec.query } : {}),
        ...(spec.body ? { body: spec.body } : {}),
        response: { [status]: spec.response },
        ...(spec.multipart ? { consumes: ['multipart/form-data'] } : {}),
        security: isPublic ? [] : [{ bearerAuth: [] }, { devPersona: [] }],
      },
      onRequest: async (request) => authenticate(request),
      ...(HEAVY_ROUTES.has(id)
        ? { preHandler: async (request: FastifyRequest) => limitHeavy(request) }
        : {}),
      handler: async (request, response) => {
        void response.code(status);
        try {
          return await run(request, response);
        } catch (error) {
          await auditFailure(request, error, { id, audited });
          throw error;
        }
      },
    });
  }
}

interface IdempotentRun {
  readonly key: string;
  readonly scope: string;
  readonly status: number;
  readonly requestHash: string;
  readonly execute: () => Promise<unknown>;
}

async function runIdempotent(
  ctx: RequestContext,
  response: FastifyReply,
  run: IdempotentRun,
): Promise<unknown> {
  const begin = await ctx.repos.idempotency.begin(run.key, run.scope, run.requestHash);
  switch (begin.state) {
    case 'replay':
      void response.header(REPLAY_HEADER, 'true');
      return begin.response;
    case 'conflict':
      throw new IdempotencyConflictError();
    case 'in_progress':
      throw new ConflictError('A request with this Idempotency-Key is still being processed');
    case 'new':
      break;
  }
  try {
    const body = await run.execute();
    await ctx.repos.idempotency.complete(run.key, run.scope, run.status, body);
    return body;
  } catch (error) {
    // Free the key so the client can retry; the failed attempt left no stored response.
    await ctx.repos.idempotency.release(run.key, run.scope).catch((releaseError: unknown) => {
      ctx.logger.warn({ err: releaseError }, 'could not release idempotency key');
    });
    throw error;
  }
}

/**
 * Audits refusals (always) and server faults of state-changing requests. Never masks the original
 * error: a failure to write the audit event is logged and the original error is rethrown by the caller.
 */
async function auditFailure(
  request: FastifyRequest,
  error: unknown,
  route: { id: RouteId; audited: boolean },
): Promise<void> {
  const ctx = request.cg.ctx;
  if (ctx === null) return;
  const verdict = toProblem(error, { requestId: request.cg.requestId });
  const worthRecording = verdict.denied || (route.audited && verdict.status >= 500);
  if (!worthRecording) return;
  try {
    await ctx.audit({
      action: verdict.denied ? 'access.denied' : `api.${route.id}`,
      targetType: 'route',
      targetId: firstParam(request.params),
      caseId: caseIdOf(request.params),
      outcome: verdict.denied ? 'denied' : 'failure',
      details: { routeId: route.id, code: verdict.problem.code, status: verdict.status },
    });
  } catch (auditError) {
    request.log.error({ err: auditError }, 'could not write audit event for a failed request');
  }
}
