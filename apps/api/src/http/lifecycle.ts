import type { FastifyInstance } from 'fastify';
import {
  correlationResponseHeaders,
  createRequestContext,
  runWithContext,
} from '@caseguard/observability';
import { API_CONTENT_SECURITY_POLICY, buildSecurityHeaders } from '@caseguard/security';
import type { Infrastructure } from '../infrastructure';
import './fastify-types';

/** Orchestrator probes hit these every few seconds; they are logged at debug level only. */
export const PROBE_PATHS: ReadonlySet<string> = new Set(['/livez', '/healthz', '/readyz']);

/**
 * Per-request plumbing that must wrap everything else, so it is registered first:
 * correlation context (request id, trace ids; follows async work), base security headers, the abort
 * signal tied to the client connection, and request metrics and the access log once the response is done.
 */
export function registerLifecycle(
  app: FastifyInstance,
  infra: Pick<Infrastructure, 'metrics'>,
): void {
  app.decorateRequest('cg', null as never);

  app.addHook('onRequest', (request, reply, done) => {
    const correlation = createRequestContext({
      headers: request.headers,
      generateRequestId: () => request.id,
    });
    const abort = new AbortController();
    request.cg = {
      requestId: correlation.requestId,
      startedAt: performance.now(),
      routeId: null,
      auth: null,
      ctx: null,
      audited: false,
      abort,
    };

    // The response is JSON for authenticated callers: never cache it, never frame it, never sniff it.
    void reply.headers({
      ...buildSecurityHeaders({ secureTransport: request.protocol === 'https' }),
      'content-security-policy': API_CONTENT_SECURITY_POLICY,
      'cross-origin-resource-policy': 'same-site',
      'x-permitted-cross-domain-policies': 'none',
      'cache-control': 'no-store',
    });
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) abort.abort();
    });

    runWithContext(correlation, () => {
      void reply.headers(correlationResponseHeaders());
      done();
    });
  });

  app.addHook('onResponse', (request, reply, done) => {
    const durationMs = performance.now() - request.cg.startedAt;
    const route = request.routeOptions.url;
    infra.metrics.recordHttpRequest({
      method: request.method,
      route,
      statusCode: reply.statusCode,
      durationMs,
    });
    // Never log the raw URL or query string: they can carry search terms and identifiers.
    const fields = {
      method: request.method,
      route: route ?? 'unmatched',
      statusCode: reply.statusCode,
      durationMs: Math.round(durationMs),
    };
    if (route !== undefined && PROBE_PATHS.has(route))
      request.log.debug(fields, 'request completed');
    else if (reply.statusCode >= 500) request.log.error(fields, 'request completed');
    else request.log.info(fields, 'request completed');
    done();
  });
}
