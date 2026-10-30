import { palettes, type ThemeName } from '../tokens/palette';

/** User preference for the colour theme. `system` follows `prefers-color-scheme`. */
export type ThemeMode = 'light' | 'dark' | 'system';

export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system'];
/** Cookie that carries the preference so the server can render the right theme without a flash. */
export const THEME_COOKIE = 'cg-theme';
const THEME_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

/** Coerces untrusted input (cookie value, query string) to a valid mode. */
export function parseThemeMode(
  value: string | null | undefined,
  fallback: ThemeMode = 'system',
): ThemeMode {
  return isThemeMode(value) ? value : fallback;
}

/** Reads the preference from a `Cookie` header or `document.cookie` string. */
export function readThemeCookie(
  cookieString: string | null | undefined,
  fallback: ThemeMode = 'system',
): ThemeMode {
  if (!cookieString) return fallback;
  for (const part of cookieString.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === THEME_COOKIE) {
      return parseThemeMode(decodeURIComponent(part.slice(separator + 1).trim()), fallback);
    }
  }
  return fallback;
}

/** Serialises the preference as a first-party, one-year, `SameSite=Lax` cookie. */
export function serializeThemeCookie(mode: ThemeMode, options: { secure?: boolean } = {}): string {
  const attributes = [
    `${THEME_COOKIE}=${encodeURIComponent(mode)}`,
    'Path=/',
    `Max-Age=${THEME_COOKIE_MAX_AGE_SECONDS}`,
    'SameSite=Lax',
  ];
  if (options.secure) attributes.push('Secure');
  return attributes.join('; ');
}

/** Persists the preference in the browser. */
export function writeThemeCookie(mode: ThemeMode, doc: Pick<Document, 'cookie'> = document): void {
  const secure = typeof location !== 'undefined' && location.protocol === 'https:';
  doc.cookie = serializeThemeCookie(mode, { secure });
}

/** Resolves `system` using the current media-query result. */
export function resolveThemeMode(mode: ThemeMode, systemPrefersDark: boolean): ThemeName {
  if (mode === 'system') return systemPrefersDark ? 'dark' : 'light';
  return mode;
}

/** Canvas colour per mode, used for `<meta name="theme-color">`. */
export function themeColorFor(mode: ThemeName): string {
  return palettes[mode].surfaces.canvas;
}
