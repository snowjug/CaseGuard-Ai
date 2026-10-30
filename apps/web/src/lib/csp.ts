/**
 * Content-Security-Policy builder. Local on purpose: the web app does not depend on @caseguard/security.
 * The policy is built per request in `src/proxy.ts` because it carries a fresh nonce.
 */

export interface CspOptions {
  /** Per-request nonce; allowed for inline/bootstrap scripts that Next.js emits. */
  nonce: string;
  /** Development needs `eval` (React debugging) and websockets (HMR). */
  isDevelopment: boolean;
  /** Entra authority URL (`NEXT_PUBLIC_ENTRA_AUTHORITY`) when Entra sign-in is configured. */
  entraAuthority?: string | undefined;
  /**
   * Adds `upgrade-insecure-requests` (default: on outside development). The proxy turns it off for requests that
   * arrive over plain http, such as a LAN demo, where upgrading every sub-resource to https would leave a blank page.
   */
  upgradeInsecureRequests?: boolean | undefined;
}

/** Cryptographically random, base64 nonce (128 bits). */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Origin of the Entra authority (the CSP source for token requests), or null when unset or malformed. */
export function entraOrigin(authority: string | undefined): string | null {
  if (!authority) return null;
  try {
    const url = new URL(authority);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** Builds the policy header value. */
export function buildCsp({
  nonce,
  isDevelopment,
  entraAuthority,
  upgradeInsecureRequests,
}: CspOptions): string {
  const entra = entraOrigin(entraAuthority);
  const directives: [string, string[]][] = [
    ['default-src', ["'self'"]],
    [
      'script-src',
      [
        "'self'",
        `'nonce-${nonce}'`,
        "'strict-dynamic'",
        ...(isDevelopment ? ["'unsafe-eval'"] : []),
      ],
    ],
    // Fluent UI (Griffel) inserts <style> rules at runtime and via inline style attributes. A nonce cannot be applied
    // to runtime-inserted rules, and adding a nonce here would make browsers ignore 'unsafe-inline'. Scripts, the
    // dangerous part, stay nonce-only; styles cannot execute code.
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:']],
    ['font-src', ["'self'", 'data:']],
    [
      'connect-src',
      ["'self'", ...(entra ? [entra] : []), ...(isDevelopment ? ['ws:', 'wss:'] : [])],
    ],
    ['frame-src', entra ? [entra] : ["'none'"]],
    ['frame-ancestors', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['object-src', ["'none'"]],
  ];
  const policy = directives.map(([name, values]) => `${name} ${values.join(' ')}`);
  if (upgradeInsecureRequests ?? !isDevelopment) policy.push('upgrade-insecure-requests');
  return policy.join('; ');
}
