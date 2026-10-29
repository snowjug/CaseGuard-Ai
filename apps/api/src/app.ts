import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { TrustProxySetting } from '@caseguard/config';
import { acceptRequestId, newRequestId } from '@caseguard/observability';
import { frameworkErrorHandler, registerErrorHandling } from './http/error-handling';
import { registerHealthRoutes } from './http/health-routes';
import { registerLifecycle } from './http/lifecycle';
import { registerOpenApi } from './http/openapi';
import { registerRoutes, type HandlerMap } from './http/route-binder';
import { registerSecurity } from './http/security';
import type { Infrastructure } from './infrastructure';

export interface BuildAppOptions {
  readonly infra: Infrastructure;
  readonly handlers: HandlerMap;
  /**
   * Refuse to start when a documented route has no handler. Deployed environments always require it;
   * focused tests may build partial apps.
   */
  readonly requireComplete?: boolean;
}

/** Longest time a client may take to send a complete request (slow-body protection). */
const REQUEST_TIMEOUT_MS = 60_000;
/** The ids of path parameters are short; anything longer is not a real identifier. */
const MAX_PARAM_LENGTH = 200;
/**
 * Longer than the idle timeout of the usual fronting proxies (Azure Container Apps ingress and load
 * balancers sit around 60 s), so the proxy never reuses a connection this server already closed.
 */
const KEEP_ALIVE_TIMEOUT_MS = 65_000;

/**
 * Fastify wants a mutable list, and a hop count as a function (`hop` is 0 for the socket peer, which
 * is the nearest proxy): `1` believes the nearest proxy only, so the address it appended to
 * `X-Forwarded-For` wins over whatever a client sent before it.
 */
function proxyTrust(setting: TrustProxySetting): NonNullable<FastifyServerOptions['trustProxy']> {
  if (typeof setting === 'number') return (_address, hop) => hop < setting;
  return typeof setting === 'object' ? [...setting] : setting;
}

/**
 * Assembles the HTTP server: correlation and metrics, security headers, CORS, rate limits, uploads,
 * the OpenAPI document, health probes and every route of the contract. Nothing is started here;
 * the caller decides whether to `listen` (main) or `inject` (tests).
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { infra } = options;
  const { config } = infra;
  // Typed as the base logger so the instance matches the `FastifyInstance` the plugins accept.
  const loggerInstance: FastifyBaseLogger = infra.logger;

  const app = Fastify({
    loggerInstance,
    // Access logging is done by the lifecycle hook (route pattern only, never the raw URL).
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: 'requestId',
    }),
    genReqId: (request) => acceptRequestId(request.headers['x-request-id']) ?? newRequestId(),
    trustProxy: proxyTrust(config.http.trustProxy),
    bodyLimit: config.http.bodyLimitBytes,
    requestTimeout: REQUEST_TIMEOUT_MS,
    keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
    frameworkErrors: frameworkErrorHandler(infra),
    // GET handlers are never run a second time for HEAD: the contract documents GET only.
    exposeHeadRoutes: false,
    return503OnClosing: true,
    routerOptions: { maxParamLength: MAX_PARAM_LENGTH },
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  registerLifecycle(app, infra);
  await registerSecurity(app, infra);
  registerErrorHandling(app, infra);
  await registerOpenApi(app, infra);
  registerHealthRoutes(app, infra);
  registerRoutes(app, {
    infra,
    handlers: options.handlers,
    requireComplete: options.requireComplete ?? config.runtime.deployed,
  });

  await app.ready();
  return app;
}
