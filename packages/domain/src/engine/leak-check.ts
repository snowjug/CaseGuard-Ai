import type { CaseEvent } from '@caseguard/schemas';
import type { CompiledPack } from '../knowledge/compile';
import type { PreResolutionView } from './temporal';

/**
 * Distinctive identifiers: IPv4 addresses, dotted host names, vendor-style codes and GUIDs.
 *
 * The host-name alternative may only begin where a host name can begin. Trying it at every word
 * boundary inside a long `a-a-a-...` run rescans the rest of the run each time (quadratic). The three
 * lookbehinds keep exactly the starts the unrestricted pattern would have used first in a run: after a
 * non-run character, after leading hyphens, or at the first hyphen of a run that follows an
 * underscore. Matches are identical except for hyphen-led fragments that directly follow another
 * match (for example the stray "-10.0.0.9" the unrestricted pattern reports for "10.0.0.1-10.0.0.9").
 */
const DISTINCTIVE_TOKEN =
  /\b(?:\d{1,3}(?:\.\d{1,3}){3}|(?:(?<![a-z0-9-])|(?<=(?<![a-z0-9-])-+)|(?<=_[a-z0-9]+))[a-z0-9-]+(?:\.[a-z0-9-]+){2,}|[a-z]{2,}\d{2,}[a-z0-9]*|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{20,})\b/gi;

/**
 * Characters scanned per text. A schema-valid event (20,000-character body plus a 200-character title)
 * fits; the cap only trims text that did not come through the bundle schema.
 */
export const MAX_LEAK_SCAN_CHARS = 32_768;

/** Lower-cased distinctive identifiers found in the first `MAX_LEAK_SCAN_CHARS` of `text`. */
export function distinctiveTokens(text: string): Set<string> {
  const scanned = text.length > MAX_LEAK_SCAN_CHARS ? text.slice(0, MAX_LEAK_SCAN_CHARS) : text;
  return new Set((scanned.match(DISTINCTIVE_TOKEN) ?? []).map((t) => t.toLowerCase()));
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value !== null && typeof value === 'object')
    for (const item of Object.values(value)) collectStrings(item, out);
}

/**
 * Distinctive identifiers that appear in the knowledge pack's own text. Scenario steps are written
 * from that text, so such an identifier cannot have come from a later event even when real cases
 * quote the same code.
 */
export function packStaticTokens(pack: CompiledPack): Set<string> {
  const strings: string[] = [];
  collectStrings(pack.pack, strings);
  const tokens = new Set<string>();
  for (const text of strings) for (const token of distinctiveTokens(text)) tokens.add(token);
  return tokens;
}

/**
 * Distinctive identifiers (IPs, hostnames, codes) that occur only after the boundary or in the
 * resolution. Identifiers in `ignore` (for example the pack's own text) are never reported.
 */
export function futureOnlyTokens(
  allEvents: readonly CaseEvent[],
  preView: PreResolutionView,
  resolutionText: string,
  ignore: ReadonlySet<string> = new Set<string>(),
): Set<string> {
  const known = new Set<string>();
  for (const e of preView.events)
    for (const t of distinctiveTokens(`${e.title ?? ''} ${e.body}`)) known.add(t);
  const visible = new Set(preView.events.map((e) => e.id));
  const future = new Set<string>();
  const consider = (token: string): void => {
    if (!known.has(token) && !ignore.has(token)) future.add(token);
  };
  for (const e of allEvents) {
    if (visible.has(e.id)) continue;
    for (const t of distinctiveTokens(`${e.title ?? ''} ${e.body}`)) consider(t);
  }
  for (const t of distinctiveTokens(resolutionText)) consider(t);
  return future;
}

export function scanForLeaks(
  texts: readonly string[],
  futureTokens: ReadonlySet<string>,
): string[] {
  const haystack = texts.join('\n').toLowerCase();
  return [...futureTokens].filter((t) => haystack.includes(t));
}
