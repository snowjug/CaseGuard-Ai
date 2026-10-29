import { UnsafeUrlError } from './errors';

/*
 * Outbound URL screening (NFR-SEC-04, threat T14). CaseGuard never fetches a URL a user typed;
 * the only outbound calls are to operator-configured provider endpoints. This is the guard those
 * calls pass through, so a misconfigured or tampered endpoint cannot reach internal services or the
 * cloud metadata address. The host allowlist is the primary control; the private-range and
 * IP-literal checks are defence in depth and give precise error reasons.
 *
 * Limitation: this inspects the URL text only. It cannot see what a DNS name resolves to, so a
 * hostile resolver for an allowed name is out of scope (pin or validate resolved addresses in the
 * HTTP client if that matters), and redirects must not be followed blindly.
 */

export interface SafeOutboundUrlOptions {
  /** Exact hostnames (`api.example.com`) or `*.suffix` wildcards matching any sub-domain of the suffix. */
  allowedHosts: readonly string[];
  /** Permit `http:` (local mocks only). Off by default. */
  allowHttp?: boolean;
  /** Ports allowed in addition to the protocol default (443 for https, 80 for http). */
  allowedPorts?: readonly number[];
}

const MAX_URL_LENGTH = 2048;
const HOSTNAME_PATTERN =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

function hasControlOrSpace(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

// ------------------------------------------------------------------ IP classification

function parseIpv4(host: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

function isNonPublicIpv4(octets: readonly number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** Eight 16-bit groups of an IPv6 address, or null when it is not one. */
function parseIpv6(text: string): number[] | null {
  let address = text;
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (dotted?.[1] !== undefined) {
    const octets = parseIpv4(dotted[1]);
    if (octets === null) return null;
    const hi = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const lo = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    address = `${address.slice(0, address.length - dotted[1].length)}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    if (!groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return null;
    return groups.map((group) => Number.parseInt(group, 16));
  };
  const head = parse(halves[0] ?? '');
  const tail = parse(halves[1] ?? '');
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...Array<number>(missing).fill(0), ...tail];
}

function isNonPublicIpv6(groups: readonly number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const embedded = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];
  const zeros = (count: number): boolean => groups.slice(0, count).every((group) => group === 0);
  if (zeros(8) || (zeros(7) && g7 === 1)) return true; // :: and ::1
  if (zeros(5) && (g5 === 0xffff || g5 === 0)) return isNonPublicIpv4(embedded); // mapped / compatible
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isNonPublicIpv4(embedded); // NAT64
  }
  if (g0 === 0x2002) return isNonPublicIpv4([g1 >> 8, g1 & 0xff, g2 >> 8, g2 & 0xff]); // 6to4
  return (
    (g0 & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (g0 & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (g0 & 0xffc0) === 0xfec0 || // deprecated site-local
    (g0 & 0xff00) === 0xff00 || // multicast
    (g0 === 0x2001 && g1 === 0x0db8) || // documentation
    (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) // discard-only
  );
}

const LOCAL_NAME_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.lan',
  '.home.arpa',
  '.localdomain',
  '.intranet',
  '.corp',
];
const LOCAL_NAMES = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'instance-data',
  'metadata',
]);

/**
 * True for hosts that are not on the public internet: localhost and internal-looking names, private,
 * loopback, link-local, carrier-grade NAT, documentation, multicast and reserved IPv4/IPv6 ranges,
 * the cloud metadata address, and numeric tricks such as `2130706433`, `0x7f.1` or `0177.0.0.1`.
 * Anything it cannot parse as a host is treated as unsafe.
 */
export function isPrivateOrLoopbackHost(host: string): boolean {
  let candidate = host.trim().toLowerCase();
  if (candidate.startsWith('[') && candidate.endsWith(']')) candidate = candidate.slice(1, -1);
  candidate = candidate.replace(/%[0-9a-z._~-]+$/, '').replace(/\.$/, '');
  if (candidate === '') return true;
  if (
    LOCAL_NAMES.has(candidate) ||
    LOCAL_NAME_SUFFIXES.some((suffix) => candidate.endsWith(suffix))
  ) {
    return true;
  }

  if (candidate.includes(':')) {
    const groups = parseIpv6(candidate);
    return groups === null ? true : isNonPublicIpv6(groups);
  }

  // Let the URL parser fold decimal, hex, octal and short forms into dotted quads before judging.
  let normalized = candidate;
  if (/^[0-9a-fx.]+$/.test(candidate) || /^\d/.test(candidate)) {
    try {
      normalized = new URL(`http://${candidate}/`).hostname;
    } catch {
      return true;
    }
  }
  const octets = parseIpv4(normalized);
  return octets !== null ? isNonPublicIpv4(octets) : false;
}

// ------------------------------------------------------------------ allowlist

interface AllowedHost {
  readonly suffix: string;
  readonly wildcard: boolean;
}

function parseAllowedHosts(entries: readonly string[]): AllowedHost[] {
  return entries.map((entry) => {
    const lower = entry.trim().toLowerCase();
    const wildcard = lower.startsWith('*.');
    const host = wildcard ? lower.slice(2) : lower;
    if (!HOSTNAME_PATTERN.test(host) || (wildcard && !host.includes('.'))) {
      throw new TypeError(
        'allowedHosts entries must be hostnames or "*.suffix" wildcards with at least two labels',
      );
    }
    return { suffix: host, wildcard };
  });
}

function isAllowedHost(host: string, allowed: readonly AllowedHost[]): boolean {
  return allowed.some((entry) =>
    entry.wildcard ? host.endsWith(`.${entry.suffix}`) : host === entry.suffix,
  );
}

/**
 * Returns the parsed URL if it is safe to call, otherwise throws `UnsafeUrlError`. Use the
 * returned `URL` (not the original string) for the request so parser differences cannot matter.
 * https only (unless `allowHttp`), no embedded credentials, no IP literals, no local or private
 * hosts, host on the allowlist, and only the default port (or `allowedPorts`).
 */
export function assertSafeOutboundUrl(input: string | URL, options: SafeOutboundUrlOptions): URL {
  const allowed = parseAllowedHosts(options.allowedHosts);
  const raw = typeof input === 'string' ? input : input.href;

  if (
    raw.length === 0 ||
    raw.length > MAX_URL_LENGTH ||
    hasControlOrSpace(raw) ||
    raw.includes('\\')
  ) {
    throw new UnsafeUrlError('invalid_url', 'The URL is not valid');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('invalid_url', 'The URL is not valid');
  }

  const httpAllowed = options.allowHttp === true;
  if (url.protocol !== 'https:' && !(httpAllowed && url.protocol === 'http:')) {
    throw new UnsafeUrlError('protocol_not_allowed', 'Only https URLs are allowed');
  }
  if (url.username !== '' || url.password !== '' || /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(raw)) {
    throw new UnsafeUrlError('credentials_in_url', 'URLs must not contain credentials');
  }

  const host = url.hostname.replace(/\.$/, '');
  if (host === '' || host.startsWith('[') || parseIpv4(host) !== null) {
    throw new UnsafeUrlError('ip_literal_host', 'IP addresses are not allowed as hosts');
  }
  if (isPrivateOrLoopbackHost(host)) {
    throw new UnsafeUrlError('private_or_local_host', 'Private and local hosts are not allowed');
  }
  if (!isAllowedHost(host, allowed)) {
    throw new UnsafeUrlError('host_not_allowed', 'The host is not on the allowlist');
  }

  if (url.port !== '' && !(options.allowedPorts ?? []).includes(Number(url.port))) {
    throw new UnsafeUrlError('port_not_allowed', 'The port is not allowed');
  }
  return url;
}

// ------------------------------------------------------------------ redirects

function hasControlOrBackslash(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x5c) return true;
  }
  return false;
}

function decodeRepeatedly(text: string): string | null {
  let current = text;
  for (let i = 0; i < 3; i += 1) {
    try {
      const next = decodeURIComponent(current);
      if (next === current) return current;
      current = next;
    } catch {
      return null;
    }
  }
  return current;
}

/**
 * Open-redirect guard: returns `path` only if it is a same-origin relative path (`/cases/1?x=2`);
 * anything else (absolute URLs, `//host`, `/\host`, encoded variants, control characters) yields
 * `fallback`. Never throws.
 */
export function safeRelativeRedirect(path: unknown, fallback = '/'): string {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_URL_LENGTH)
    return fallback;
  if (!path.startsWith('/') || path.startsWith('//') || hasControlOrBackslash(path))
    return fallback;

  const decoded = decodeRepeatedly(path);
  if (decoded === null || decoded.startsWith('//') || hasControlOrBackslash(decoded))
    return fallback;

  try {
    const parsed = new URL(path, 'https://app.invalid');
    if (parsed.origin !== 'https://app.invalid') return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
