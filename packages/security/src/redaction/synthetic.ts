/*
 * Values that exist to be fake. Synthetic case data (and documentation) uses them on purpose, and
 * redacting them would destroy the evidence analysis relies on, so redaction leaves them alone
 * unless `redactReservedValues` is set.
 */

/** Reserved top-level names (RFC 2606 / RFC 6761): never delegated, so never a real person's mailbox. */
const RESERVED_TLDS = ['invalid', 'example', 'test', 'localhost'];
/** Second-level names IANA reserves for documentation (RFC 2606). Sub-domains count too. */
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];

/** True for e-mail domains that are reserved for tests and documentation. */
export function isReservedEmailDomain(domain: string): boolean {
  const lower = domain.toLowerCase().replace(/\.$/, '');
  if (RESERVED_TLDS.some((tld) => lower === tld || lower.endsWith(`.${tld}`))) return true;
  return RESERVED_DOMAINS.some((reserved) => lower === reserved || lower.endsWith(`.${reserved}`));
}

/**
 * True for IPv4 addresses that cannot identify a real public host: RFC 1918 private ranges
 * (10/8, 172.16/12, 192.168/16), loopback (127/8), link-local (169.254/16) and the RFC 5737
 * documentation ranges (192.0.2/24, 198.51.100/24, 203.0.113/24).
 */
export function isNonRoutableIpv4(octets: readonly number[]): boolean {
  const [a = -1, b = -1, c = -1] = octets;
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}
