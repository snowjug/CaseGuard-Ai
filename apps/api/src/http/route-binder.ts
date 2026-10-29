import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { z } from 'zod';
import type { ProductMetrics } from '@caseguard/observability';
import type { AppConfig } from '@caseguard/config';
import { IdSchema, ROUTES, type RouteId, type RouteSpec } from '@caseguard/schemas';
import { AuthenticationError, AuthorizationError, type AuthContext } from '@caseguard/security';
import { setContextValue } from '@caseguard/observability';
import { NotImplementedError, RateLimitedError } from '../errors';
import type { Infrastructure } from '../infrastructure';
import { buildRequestContext } from './context-factory';
import { DenialAuditThrottle } from './denial-throttle';
import './fastify-types';
import { hashRequest, idempotencyScope, readIdempotencyKey, runIdempotent } from './idempotency';
import type { RequestContext } from './request-context';
import { toProblem } from './problem';
import { readUpload, type UploadedFile } from './upload';

export type { UploadedFile } from './upload';

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

/**
 * An identifier from the request that may go into an audit event. Path parameters are raw at the
 * point of authorization (they are validated later), so anything that is not a well-formed id is
 * dropped rather than allowed to make the audit write fail.
 */
function auditableId(value: unknown): string | null {
  const parsed = IdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function firstParam(params: unknown): string | null {
  if (typeof params !== 'object' || params === null) return null;
  for (const value of Object.values(params))
    if (typeof value === 'string') return auditableId(value);
  return null;
}

function caseIdOf(params: unknown): string | null {
  if (typeof params !== 'object' || params === null) return null;
  return auditableId((params as { caseId?: unknown }).caseId);
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
  // Runs first on every route: unauthenticated and forbidden requests are throttled like any other,
  // so credential guessing and permission probing cost the caller their quota.
  const generalLimit = app.rateLimit();
  const heavyLimit = app.createRateLimit({
    max: config.limits.rateLimitAiMax,
    timeWindow: windowMs,
    keyGenerator: (request) => {
      const auth = request.cg.auth;
      return auth === null ? `ip:${request.ip}` : `user:${auth.tenantId}:${auth.userId}`;
    },
  });
  const denialThrottle = new DenialAuditThrottle(windowMs, () => infra.now().getTime());

  /**
   * Audits a refusal, at most once per caller and route per window (see `DenialAuditThrottle`). A
   * failure to write the event is logged and never replaces the refusal itself.
   */
  const auditDenial = async (
    request: FastifyRequest,
    routeId: RouteId,
    targetId: string | null,
    details: Record<string, unknown>,
  ): Promise<void> => {
    const { ctx, auth } = request.cg;
    if (ctx === null || auth === null) return;
    const verdict = denialThrottle.admit(`${auth.tenantId}:${auth.userId}:${routeId}`);
    if (!verdict.write) return;
    try {
      await ctx.audit({
        action: 'access.denied',
        targetType: 'route',
        targetId,
        caseId: caseIdOf(request.params),
        outcome: 'denied',
        details: {
          ...details,
          ...(verdict.suppressed > 0 ? { suppressedSincePrevious: verdict.suppressed } : {}),
        },
      });
    } catch (error) {
      request.log.error(
        { err: error, event: 'audit.write_failed', routeId },
        'could not write the access-denied audit event',
      );
    }
  };

  /**
   * Audits server faults of state-changing requests and refusals raised inside a handler. Never masks
   * the original error: a failure to write the audit event is logged and the caller rethrows.
   */
  const auditFailure = async (
    request: FastifyRequest,
    error: unknown,
    route: { id: RouteId; method: string; audited: boolean },
  ): Promise<void> => {
    const ctx = request.cg.ctx;
    if (ctx === null) return;
    const verdict = toProblem(error, { requestId: request.cg.requestId });
    const details = { routeId: route.id, code: verdict.problem.code, status: verdict.status };
    if (verdict.denied) {
      await auditDenial(request, route.id, firstParam(request.params), details);
      return;
    }
    if (!route.audited || verdict.status < 500) return;
    try {
      await ctx.audit({
        action: `api.${route.id}`,
        targetType: 'route',
        targetId: firstParam(request.params),
        caseId: caseIdOf(request.params),
        outcome: 'failure',
        details,
      });
    } catch (auditError) {
      request.log.error({ err: auditError }, 'could not write audit event for a failed request');
    }
  };

  for (const [id, spec] of Object.entries(ROUTES) as [RouteId, RouteSpec][]) {
    const handler = handlers[id] as AnyHandler | undefined;
    const isPublic = PUBLIC_ROUTES.has(id);
    const mutating = spec.method !== 'GET';
    const audited = mutating || AUDITED_READS.has(id);
    const status = spec.status ?? 200;

    const markRoute = async (request: FastifyRequest): Promise<void> => {
      request.cg.routeId = id;
    };

    const authenticate = async (request: FastifyRequest): Promise<void> => {
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
        await auditDenial(request, id, id, {
          routeId: id,
          method: spec.method,
          requiredPermission: spec.permission,
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
        spec.multipart === true
          ? await readUpload(request, response, config.http.uploadMaxBytes)
          : undefined;
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
      let replayed = false;
      if (idempotencyKey !== null && tenantCtx !== null) {
        const outcome = await runIdempotent(tenantCtx, response, {
          key: idempotencyKey,
          scope: idempotencyScope(id, tenantCtx.auth.userId),
          status,
          requestHash: hashRequest({
            routeId: id,
            params: request.params,
            query: request.query,
            body: request.body,
            file: file === undefined ? undefined : { sha256: file.sha256, name: file.fileName },
          }),
          execute,
        });
        body = outcome.body;
        replayed = outcome.replayed;
      } else {
        body = await execute();
      }

      if (tenantCtx !== null && audited && !request.cg.audited) {
        // The work is already committed: a failure to record it must not turn the success into an
        // error (a retry would repeat the mutation). It is logged and counted instead.
        try {
          await tenantCtx.audit({
            action: `api.${id}`,
            targetType: 'route',
            targetId: firstParam(request.params),
            caseId: caseIdOf(request.params),
            outcome: 'success',
            details: { routeId: id, method: spec.method, ...(replayed ? { replayed: true } : {}) },
          });
        } catch (error) {
          request.log.error(
            { err: error, event: 'audit.write_failed', routeId: id },
            'could not write the audit event of a request that succeeded',
          );
          infra.metrics.recordError('audit', 'write_failed');
        }
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
      onRequest: [markRoute, generalLimit, authenticate],
      // A body-less POST to a route whose body has defaults is valid; for required fields the 422 then
      // names them instead of complaining that the body "is not an object".
      ...(spec.body
        ? {
            preValidation: async (request: FastifyRequest) => {
              if (request.body === undefined) request.body = {};
            },
          }
        : {}),
      ...(HEAVY_ROUTES.has(id)
        ? { preHandler: async (request: FastifyRequest) => limitHeavy(request) }
        : {}),
      handler: async (request, response) => {
        void response.code(status);
        try {
          return await run(request, response);
        } catch (error) {
          await auditFailure(request, error, { id, method: spec.method, audited });
          throw error;
        }
      },
    });
  }
}
