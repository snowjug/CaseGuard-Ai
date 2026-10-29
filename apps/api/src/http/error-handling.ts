import type { FastifyInstance, FastifyReply } from 'fastify';
import { NotFoundError } from '../errors';
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
