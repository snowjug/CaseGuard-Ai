import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';

/** Set by the web tier; see `HttpConfig.trustClientIpHeader`. */
export const CLIENT_IP_HEADER = 'x-cg-client-ip';

/** The longest textual IPv6 address (with a zone-free mapped IPv4 tail) is 45 characters. */
const MAX_ADDRESS_LENGTH = 45;

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
    if (typeof raw === 'string' && raw.length <= MAX_ADDRESS_LENGTH && isIP(raw.trim()) !== 0) {
      return raw.trim().toLowerCase();
    }
  }
  return request.ip;
}
