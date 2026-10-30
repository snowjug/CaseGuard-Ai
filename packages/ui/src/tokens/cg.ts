import {
  TONE_NAMES,
  TONE_ROLES,
  type Palette,
  type ToneColors,
  type ToneName,
  type ToneRole,
} from './palette';
import { borderWidth, motion, radius, space, typography } from './static';

type Cap<S extends string> = Capitalize<S>;

export type ToneTokenKey = `cgTone${Cap<ToneName>}${Cap<ToneRole>}`;
export type SeriesTokenKey =
  'cgSeries1' | 'cgSeries2' | 'cgSeries3' | 'cgSeries4' | 'cgSeries5' | 'cgSeries6';
export type PlainTokenKey =
  | 'cgCanvas'
  | 'cgSurface'
  | 'cgSurfaceRaised'
  | 'cgSurfaceSunken'
  | 'cgText'
  | 'cgTextSecondary'
  | 'cgTextMuted'
  | 'cgTextLink'
  | 'cgBorderSubtle'
  | 'cgBorderControl'
  | 'cgFocus'
  | 'cgScrim'
  | 'cgShadowLow'
  | 'cgShadowHigh';
/** Every custom CSS variable (`--<key>`) that the CaseGuard themes add on top of the Fluent tokens. */
export type CustomTokenKey = ToneTokenKey | SeriesTokenKey | PlainTokenKey;
export type CustomTokens = Record<CustomTokenKey, string>;

const capitalize = <S extends string>(value: S): Cap<S> =>
  (value.charAt(0).toUpperCase() + value.slice(1)) as Cap<S>;

/** Name of the CSS variable carrying one role of one tone, e.g. `cgToneEvidenceFg`. */
export function toneTokenKey(tone: ToneName, role: ToneRole): ToneTokenKey {
  return `cgTone${capitalize(tone)}${capitalize(role)}`;
}

/** Flattens a palette into the custom theme tokens that FluentProvider emits as CSS variables. */
export function buildCustomTokens(palette: Palette): CustomTokens {
  const tokens: Partial<CustomTokens> = {
    cgCanvas: palette.surfaces.canvas,
    cgSurface: palette.surfaces.surface,
    cgSurfaceRaised: palette.surfaces.raised,
    cgSurfaceSunken: palette.surfaces.sunken,
    cgText: palette.text.primary,
    cgTextSecondary: palette.text.secondary,
    cgTextMuted: palette.text.muted,
    cgTextLink: palette.text.link,
    cgBorderSubtle: palette.borders.subtle,
    cgBorderControl: palette.borders.control,
    cgFocus: palette.borders.focus,
    cgScrim: palette.scrim,
    cgShadowLow: palette.shadow.low,
    cgShadowHigh: palette.shadow.high,
    cgSeries1: palette.series[0],
    cgSeries2: palette.series[1],
    cgSeries3: palette.series[2],
    cgSeries4: palette.series[3],
    cgSeries5: palette.series[4],
    cgSeries6: palette.series[5],
  };
  for (const tone of TONE_NAMES) {
    for (const role of TONE_ROLES) {
      tokens[toneTokenKey(tone, role)] = palette.tones[tone][role];
    }
  }
  return tokens as CustomTokens;
}

const ref = (key: CustomTokenKey): string => `var(--${key})`;

function buildToneRefs(): Record<ToneName, ToneColors> {
  // Filled exhaustively by the loop below, so the cast only bridges the empty literal.
  const refs = {} as Record<ToneName, ToneColors>;
  for (const tone of TONE_NAMES) {
    refs[tone] = {
      fg: ref(toneTokenKey(tone, 'fg')),
      tint: ref(toneTokenKey(tone, 'tint')),
      border: ref(toneTokenKey(tone, 'border')),
      solid: ref(toneTokenKey(tone, 'solid')),
      onSolid: ref(toneTokenKey(tone, 'onSolid')),
    };
  }
  return refs;
}

const px = (value: number): string => `${value}px`;

/**
 * Typed CSS-variable references for use inside Griffel `makeStyles` (and plain `style` props).
 * Colour values are theme-aware because FluentProvider defines the variables per theme;
 * spacing, radii and motion are static.
 */
export const cg = {
  canvas: ref('cgCanvas'),
  surface: ref('cgSurface'),
  surfaceRaised: ref('cgSurfaceRaised'),
  surfaceSunken: ref('cgSurfaceSunken'),
  text: ref('cgText'),
  textSecondary: ref('cgTextSecondary'),
  textMuted: ref('cgTextMuted'),
  textLink: ref('cgTextLink'),
  borderSubtle: ref('cgBorderSubtle'),
  borderControl: ref('cgBorderControl'),
  focus: ref('cgFocus'),
  scrim: ref('cgScrim'),
  shadowLow: ref('cgShadowLow'),
  shadowHigh: ref('cgShadowHigh'),
  tone: buildToneRefs(),
  series: [
    ref('cgSeries1'),
    ref('cgSeries2'),
    ref('cgSeries3'),
    ref('cgSeries4'),
    ref('cgSeries5'),
    ref('cgSeries6'),
  ] as const,
  space: {
    0: px(space[0]),
    1: px(space[1]),
    2: px(space[2]),
    3: px(space[3]),
    4: px(space[4]),
    6: px(space[6]),
    8: px(space[8]),
  },
  radius: {
    none: '0',
    sm: px(radius.sm),
    md: px(radius.md),
    lg: px(radius.lg),
    pill: px(radius.pill),
  },
  borderWidth: {
    thin: px(borderWidth.thin),
    thick: px(borderWidth.thick),
    focus: px(borderWidth.focus),
  },
  motion: {
    fast: `${motion.fast}ms`,
    base: `${motion.base}ms`,
    slow: `${motion.slow}ms`,
    easing: motion.easing,
  },
  font: {
    mono: typography.family.mono,
  },
} as const;
