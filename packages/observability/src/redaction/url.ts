import { classifyKey } from './keys';
import { REDACTED } from './rules';

const MAX_URL_LENGTH = 2048;
const RELATIVE_BASE = 'http://relative.invalid';

/**
 * Removes credentials, fragments and sensitive query values from a URL before it is logged.
 * Relative URLs (what servers see in `request.url`) keep only path and query. Never throws.
 */
export function sanitizeUrlWith(input: string, scrubText: (text: string) => string): string {
  const bounded = input.length > MAX_URL_LENGTH ? input.slice(0, MAX_URL_LENGTH) : input;
  let parsed: URL;
  let relative = false;
  try {
    parsed = new URL(bounded);
  } catch {
    // Not an absolute URL: resolving against a dummy base is the expected path for request targets.
    try {
      parsed = new URL(bounded, RELATIVE_BASE);
      relative = true;
    } catch {
      return scrubText(bounded);
    }
  }
  if (!relative && parsed.host === '') return scrubText(bounded);

  const pairs: string[] = [];
  for (const [key, value] of parsed.searchParams) {
    const sensitive = classifyKey(key) !== 'none';
    pairs.push(
      `${encodeURIComponent(key)}=${sensitive ? REDACTED : encodeURIComponent(scrubText(value))}`,
    );
  }
  const query = pairs.length > 0 ? `?${pairs.join('&')}` : '';
  const path = scrubText(parsed.pathname);
  return relative ? `${path}${query}` : `${parsed.protocol}//${parsed.host}${path}${query}`;
}
