import type { FastifyInstance, FastifyRequest } from 'fastify';
import { safeErrorCode, startServerSpan, type ServerSpan } from '@caseguard/observability';
import type { Infrastructure } from '../infrastructure';
import type { RequestState } from './fastify-types';
import { PROBE_PATHS } from './lifecycle';

export interface TracingOptions {
  /** Route patterns that are never traced. Defaults to the orchestrator probes: they run every few seconds. */
  readonly ignoreRoutes?: ReadonlySet<string>;
}

/**
 * One OpenTelemetry SERVER span per request, named after the route id (never the URL) and carrying
 * only the attributes listed in `SERVER_SPAN_ATTRIBUTES`: no tenant, user or case ids, no headers, no
 * bodies, no query strings. While no OpenTelemetry SDK is registered, which is whenever telemetry
 * export is off, each hook returns after one global lookup and nothing else happens.
 *
 * It is registered right after `registerLifecycle`: the correlation context already exists when the
 * span starts, so the span's ids replace the generated ones in log lines and outgoing headers. The
 * span ends when the response is finished, or when the connection closes without one (an aborted
 * request). A failure inside tracing is counted and reported once, and never reaches the request.
 */
export function registerTracing(
  app: FastifyInstance,
  infra: Pick<Infrastructure, 'metrics' | 'logger'>,
  options: TracingOptions = {},
): void {
  const ignored = options.ignoreRoutes ?? PROBE_PATHS;
  const spans = new WeakMap<FastifyRequest, ServerSpan>();
  let reported = false;

  const report = (error: unknown): void => {
    infra.metrics.recordError('telemetry', 'span_failed');
    if (reported) return;
    reported = true;
    infra.logger.warn(
      { event: 'telemetry.tracing_failed', code: safeErrorCode(error) },
      'request tracing failed; requests continue without spans',
    );
  };

  const guarded = (action: () => void): void => {
    try {
      action();
    } catch (error) {
      report(error);
    }
  };

  app.addHook('onRequest', (request, reply, done) => {
    const route = request.routeOptions.url;
    if (route !== undefined && ignored.has(route)) {
      done();
      return;
    }

    let span: ServerSpan | undefined;
    try {
      span = startServerSpan({
        method: request.method,
        route,
        routeId: request.routeOptions.config?.routeId,
        requestId: (request.cg as RequestState | null)?.requestId ?? request.id,
        traceparent: request.headers.traceparent,
        tracestate: request.headers.tracestate,
      });
    } catch (error) {
      report(error);
    }
    if (span === undefined) {
      done();
      return;
    }

    const started = span;
    spans.set(request, started);
    // `finish` fires first on a normal response; `close` alone means the client went away.
    reply.raw.once('close', () =>
      guarded(() => started.end(reply.raw.writableFinished ? reply.statusCode : undefined)),
    );

    let continued = false;
    const proceed = (): void => {
      if (continued) return;
      continued = true;
      done();
    };
    try {
      started.run(proceed);
    } catch (error) {
      report(error);
      proceed();
    }
  });

  app.addHook('onError', (request, _reply, error, done) => {
    guarded(() => spans.get(request)?.captureError(error));
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    guarded(() => spans.get(request)?.end(reply.statusCode));
    done();
  });
}
