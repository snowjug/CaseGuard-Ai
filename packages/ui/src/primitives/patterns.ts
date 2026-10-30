import type { CSSProperties } from 'react';
import { cg } from '../tokens/cg';
import type { ToneName } from '../tokens/palette';

/** Texture vocabulary shared by badges, the graph and charts. Colour is never the only signal. */
export type PatternKind = 'solid' | 'hatch' | 'dots' | 'crosshatch' | 'outline';

/**
 * CSS background for a pattern swatch in HTML (badges, legend chips). Lines use `color-mix` so the texture stays
 * subtle enough for the icon or text on top to keep its contrast.
 */
export function patternBackground(kind: PatternKind, tone: ToneName): CSSProperties {
  const t = cg.tone[tone];
  const line = `color-mix(in srgb, ${t.solid} 62%, transparent)`;
  switch (kind) {
    case 'dots':
      return {
        backgroundColor: t.tint,
        backgroundImage: `radial-gradient(${line} 1.1px, transparent 1.4px)`,
        backgroundSize: '5px 5px',
      };
    case 'hatch':
      return {
        backgroundColor: t.tint,
        backgroundImage: `repeating-linear-gradient(45deg, ${line} 0 1.5px, transparent 1.5px 5px)`,
      };
    case 'crosshatch':
      return {
        backgroundColor: t.tint,
        backgroundImage: `repeating-linear-gradient(45deg, ${line} 0 1px, transparent 1px 4px), repeating-linear-gradient(-45deg, ${line} 0 1px, transparent 1px 4px)`,
      };
    case 'outline':
      return { backgroundColor: 'transparent' };
    default:
      return { backgroundColor: t.tint };
  }
}
