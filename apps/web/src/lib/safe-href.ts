/** Only same-origin, app-relative paths may be navigated to from API-provided links (no open redirects). */
export function safeInternalHref(href: string | null | undefined): string | null {
  if (!href) return null;
  if (!href.startsWith('/') || href.startsWith('//') || href.includes('\\')) return null;
  // Reject control characters and anything that could be parsed as a different origin.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(href)) return null;
  return href;
}
