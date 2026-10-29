import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { API_CONTENT_SECURITY_POLICY, buildSecurityHeaders } from '@caseguard/security';
import { MalformedRequestError, NotFoundError } from '../errors';
import type { Infrastructure } from '../infrastructure';
import './fastify-types';
import { toProblem, type ProblemResult } from './problem';

function sendProblem(reply: FastifyReply, result: ProblemResult): FastifyReply {
  void reply.headers(result.headers);
  return reply
    .code(result.status)
    .type('application/problem+json; charset=utf-8')
    .send(JSON.stringify(result.problem));
}

/**
 * Fastify answers a few failures itself, before routing and before any hook ran (a malformed URL, for
 * example), in its own JSON shape that repeats the offending path. This keeps them in the one problem
 * format, with the same headers and a correlation id, and without echoing the request.
 */
export function frameworkErrorHandler(
  infra: Pick<Infrastructure, 'metrics'>,
): (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => void {
  return (error, request, reply) => {
    const cause =
      error.code === 'FST_ERR_BAD_URL'
        ? new MalformedRequestError('The request URL is not valid')
        : error;
    const result = toProblem(cause, { requestId: request.id });
    request.log.debug(
      { event: 'http.error', code: result.problem.code, status: result.status },
      'request rejected before routing',
    );
    infra.metrics.recordError('http', result.problem.code);
    void reply.headers({
      ...buildSecurityHeaders({ secureTransport: request.protocol === 'https' }),
      'content-security-policy': API_CONTENT_SECURITY_POLICY,
      'cache-control': 'no-store',
      'x-request-id': request.id,
    });
    sendProblem(reply, result);
  };
}

/**
 * One error path for the whole API: every failure becomes an RFC 9457 problem with a correlation id.
 * Faults are logged with the underlying error; the client only ever sees the generic message.
 */
export function registerErrorHandling(
  app: FastifyInstance,
  infra: Pick<Infrastructure, 'metrics'>,
): void {
  app.setErrorHandler((error, request, reply) => {
    const requestId = request.cg?.requestId ?? request.id;
    const result = toProblem(error, { requestId });
    const fields = {
      event: result.denied ? 'access.denied' : 'http.error',
      routeId: request.cg?.routeId ?? undefined,
      code: result.problem.code,
      status: result.status,
    };

    if (result.unexpected) request.log.error({ ...fields, err: error }, 'unhandled error');
    else if (result.status >= 500) request.log.warn({ ...fields, err: error }, 'request failed');
    else if (result.denied) request.log.info(fields, 'request denied');
    else request.log.debug(fields, 'request rejected');

    infra.metrics.recordError('http', result.problem.code);
    return sendProblem(reply, result);
  });

  // 404s are rate limited too so the route table cannot be enumerated cheaply.
  app.setNotFoundHandler({ preHandler: app.rateLimit() }, (request, reply) => {
    const result = toProblem(new NotFoundError('The requested route'), {
      requestId: request.cg?.requestId ?? request.id,
    });
    return sendProblem(reply, result);
  });
}
