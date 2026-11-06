/**
 * Server-safe helpers for the development identity (the root layout reads its cookie; no React or browser APIs here).
 * The choice lives in localStorage and, alongside it, in a first-party cookie, so the server can render a returning
 * person's page in its signed-in state instead of flashing the first-visit page until the browser has hydrated.
 */

export const PERSONA_STORAGE_KEY = 'cg-persona';
export const PERSONA_COOKIE = 'cg-persona';
const PERSONA_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;

/** Accepts only well-formed persona ids from storage or a cookie (never trust stored values). */
export function parsePersonaId(raw: string | null | undefined): string | null {
  return typeof raw === 'string' && PERSONA_ID.test(raw) ? raw : null;
}

/** The persona id of a cookie value as the browser wrote it (`encodeURIComponent`), or null when it is not one. */
export function personaIdFromCookie(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return parsePersonaId(decodeURIComponent(value));
  } catch {
    return null;
  }
}
