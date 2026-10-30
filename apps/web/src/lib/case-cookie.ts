/** Server-safe helpers for the remembered-case cookie (the root layout reads it; no React or browser APIs here). */

export const CASE_COOKIE = 'cg-case';
const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;

/** Accepts only well-formed case ids; cookies and URLs are untrusted input. */
export function parseCaseId(raw: string | null | undefined): string | null {
  return typeof raw === 'string' && CASE_ID.test(raw) ? raw : null;
}

/** Reads the case id from a `Cookie` header or `document.cookie` string. */
export function readCaseCookie(cookieString: string | null | undefined): string | null {
  if (!cookieString) return null;
  for (const part of cookieString.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1 || part.slice(0, separator).trim() !== CASE_COOKIE) continue;
    try {
      return parseCaseId(decodeURIComponent(part.slice(separator + 1).trim()));
    } catch {
      return null;
    }
  }
  return null;
}

/** `Set-Cookie`-style text for the browser: first-party, `SameSite=Lax`, 30 days; `null` clears it. */
export function serializeCaseCookie(caseId: string | null): string {
  return caseId
    ? `${CASE_COOKIE}=${encodeURIComponent(caseId)}; Path=/; SameSite=Lax; Max-Age=2592000`
    : `${CASE_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0`;
}
