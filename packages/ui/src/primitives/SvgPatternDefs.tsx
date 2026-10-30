'use client';

import { TONE_NAMES, type ToneName } from '../tokens/palette';
import { cg } from '../tokens/cg';

/** Pattern fills available inside SVG (graph nodes, chart bars and bands). */
export type SvgPatternKind = 'hatch' | 'dots' | 'crosshatch';

export const SVG_PATTERN_KINDS: readonly SvgPatternKind[] = ['hatch', 'dots', 'crosshatch'];

/** DOM id of a pattern defined by `SvgPatternDefs`. Reference it as `url(#${patternId(...)})`. */
export function patternId(idPrefix: string, kind: SvgPatternKind, tone: ToneName): string {
  return `${idPrefix}-pat-${kind}-${tone}`;
}

/** `fill`/`stroke` value that references a pattern. */
export function patternUrl(idPrefix: string, kind: SvgPatternKind, tone: ToneName): string {
  return `url(#${patternId(idPrefix, kind, tone)})`;
}

export interface SvgPatternDefsProps {
  /**
   * Unique prefix for the ids; use `useId()` (sanitised) when several SVGs share one document, because patterns
   * are resolved document-wide and a `display: none` SVG cannot supply them.
   */
  idPrefix?: string;
  /** Limit the tones to emit (default: all). Charts pass only the tones they use to keep the DOM small. */
  tones?: readonly ToneName[];
  /** Limit the pattern kinds to emit (default: all). */
  kinds?: readonly SvgPatternKind[];
}

/**
 * `<defs>` with the pattern vocabulary reused by the investigation graph and every chart:
 * diagonal hatch (simulated), dots (uncertain), cross-hatch (unsupported). Each tile carries its tone's tint as
 * the background and a translucent solid-colour texture, so labels on top stay legible.
 */
export function SvgPatternDefs({
  idPrefix = 'cg',
  tones = TONE_NAMES,
  kinds = SVG_PATTERN_KINDS,
}: SvgPatternDefsProps) {
  return (
    <defs>
      {tones.flatMap((tone) =>
        kinds.map((kind) => {
          const t = cg.tone[tone];
          const id = patternId(idPrefix, kind, tone);
          if (kind === 'dots') {
            return (
              <pattern key={id} id={id} width="6" height="6" patternUnits="userSpaceOnUse">
                <rect width="6" height="6" fill={t.tint} />
                <circle cx="3" cy="3" r="1.25" fill={t.solid} fillOpacity="0.85" />
              </pattern>
            );
          }
          if (kind === 'crosshatch') {
            return (
              <pattern key={id} id={id} width="6" height="6" patternUnits="userSpaceOnUse">
                <rect width="6" height="6" fill={t.tint} />
                <path
                  d="M0 0L6 6M6 0L0 6"
                  stroke={t.solid}
                  strokeOpacity="0.8"
                  strokeWidth="1"
                  fill="none"
                />
              </pattern>
            );
          }
          return (
            <pattern
              key={id}
              id={id}
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <rect width="6" height="6" fill={t.tint} />
              <line
                x1="0"
                y1="0"
                x2="0"
                y2="6"
                stroke={t.solid}
                strokeOpacity="0.8"
                strokeWidth="2"
              />
            </pattern>
          );
        }),
      )}
    </defs>
  );
}
