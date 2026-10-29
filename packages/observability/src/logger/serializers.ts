import type { Scrubber } from '../redaction/scrubber';
import { sanitizeUrlWith } from '../redaction/url';

const MAX_METHOD_LENGTH = 16;
const MAX_USER_AGENT_LENGTH = 200;
const MAX_ADDRESS_LENGTH = 64;

function pick(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) return undefined;
  try {
    return Reflect.get(source, key);
  } catch {
    // A hostile getter on a request object must not stop the log line from being written.
    return undefined;
  }
}

function headerValue(headers: unknown, name: string): string | undefined {
  const value = pick(headers, name);
  return typeof value === 'string' ? value : undefined;
}

function assignText(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  scrubber: Scrubber,
  maxLength: number,
): void {
  if (typeof value === 'string' && value !== '') target[key] = scrubber.text(value, maxLength);
}

/**
 * Serialiser for the `req` log key. Works on Fastify requests, Node `IncomingMessage` and the
 * plain objects pino's own mapper produces. It copies an allow-list only (id, method, sanitised
 * url, remote address, user agent): headers, query secrets and bodies never reach the log.
 */
export function createRequestSerializer(scrubber: Scrubber): (request: unknown) => unknown {
  return (request) => {
    const out: Record<string, unknown> = {};
    const id = pick(request, 'id');
    if (typeof id === 'string' || typeof id === 'number') out.id = scrubber.text(String(id), 80);
    assignText(out, 'method', pick(request, 'method'), scrubber, MAX_METHOD_LENGTH);
    const url = pick(request, 'url');
    if (typeof url === 'string') out.url = sanitizeUrlWith(url, (text) => scrubber.text(text));
    const headers = pick(request, 'headers');
    const socket = pick(request, 'socket');
    assignText(
      out,
      'remoteAddress',
      pick(request, 'ip') ?? pick(request, 'remoteAddress') ?? pick(socket, 'remoteAddress'),
      scrubber,
      MAX_ADDRESS_LENGTH,
    );
    assignText(
      out,
      'userAgent',
      headerValue(headers, 'user-agent'),
      scrubber,
      MAX_USER_AGENT_LENGTH,
    );
    return out;
  };
}

/** Serialiser for the `res` log key: status code and content length only. */
export function createResponseSerializer(): (response: unknown) => unknown {
  return (response) => {
    const out: Record<string, unknown> = {};
    const statusCode = pick(response, 'statusCode');
    if (typeof statusCode === 'number' && Number.isFinite(statusCode)) out.statusCode = statusCode;
    const length = pick(pick(response, 'headers'), 'content-length');
    const parsed = typeof length === 'string' ? Number(length) : length;
    if (typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0) {
      out.contentLength = parsed;
    }
    return out;
  };
}
