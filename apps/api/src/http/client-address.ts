import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';

/** Set by the web tier; see `HttpConfig.trustClientIpHeader`. */
export const CLIENT_IP_HEADER = 'x-cg-client-ip';

/** The longest textual IPv6 address (with a mapped IPv4 tail) is 45 characters. */
const MAX_ADDRESS_LENGTH = 45;

/** Digits, hex letters, colons and dots only: `net.isIP` also accepts an IPv6 zone id, which is free text and could mint endless buckets. */
const IP_LITERAL = /^[\da-fA-F:.]+$/;

/**
 * The address a request counts against for per-client limits.
 *
 * Behind a chain of proxies the socket peer is the last of them, and the left-most `X-Forwarded-For`
 * entry is whatever the client chose, so the hop count has to be exactly right to avoid either sharing
 * one bucket between every user of a web replica or letting a client pick its own. When the API is only
 * reachable from the web tier (internal ingress), the web tier states the address its own ingress saw in
 * `x-cg-client-ip` and removes any copy a client sent; `trustHeader` makes the API believe it. A value
 * that is not a single, well-formed IP address is ignored and the peer address is used instead.
 */
export function clientAddressOf(request: FastifyRequest, trustHeader: boolean): string {
  if (trustHeader) {
    const raw = request.headers[CLIENT_IP_HEADER];
    if (typeof raw === 'string') {
      const value = raw.trim();
      if (value.length <= MAX_ADDRESS_LENGTH && IP_LITERAL.test(value) && isIP(value) !== 0) {
        return value.toLowerCase();
      }
    }
  }
  return request.ip;
}
