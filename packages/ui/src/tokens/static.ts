/** Theme-independent design tokens: the 8-px grid, radii, motion, typography and layout. */

/**
 * The 8-px grid with two half steps (4 and 12) for fine alignment. Layout rhythm (padding, gaps between blocks) uses the
 * multiples of 8; 4 and 12 are for icon-to-label gaps and dense rows.
 */
export const space = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
} as const;
export type SpaceStep = keyof typeof space;

/**
 * Corner radii in px: 8 for chips and small controls, 12 for buttons and inputs, 16 for cards, 24 for hero panels and
 * dialogs. `pill` is for badges and avatars only.
 */
export const radius = { none: 0, sm: 8, md: 12, lg: 16, xl: 24, pill: 999 } as const;

export const borderWidth = { thin: 1, thick: 2, focus: 3 } as const;

/**
 * Motion: 150-250 ms for state changes, at most 300 ms for the few signature moments (number ticker, score ring, glint),
 * ease-out, purposeful only. Components must also honour `prefers-reduced-motion` and the in-app override
 * (see `useReducedMotion`).
 */
const curve = [0.16, 1, 0.3, 1] as const;
export const motion = {
  fast: 150,
  base: 200,
  slow: 250,
  max: 300,
  /** The one ease-out curve, as numbers for JS-driven animation (Motion) and as CSS below. */
  curve,
  easing: `cubic-bezier(${curve.join(', ')})`,
} as const;

/**
 * Type scale in px. Geist (variable, self-hosted, OFL-1.1) is the only family; scores use tabular numerals. Body is
 * never below 15 px and captions never below 13 px (badges may use 12).
 */
export const typography = {
  size: { micro: 12, caption: 13, body: 15, h3: 18, h2: 22, h1: 30, display: 48 },
  weight: { regular: 400, medium: 500, semibold: 600, bold: 700 },
  lineHeight: { tight: 1.15, snug: 1.3, normal: 1.55 },
  /** Heading tracking in em; body text keeps the font's own spacing. */
  tracking: { display: -0.03, heading: -0.02, subheading: -0.01 },
  family: {
    base: "'Geist Variable', 'Geist', system-ui, -apple-system, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
    mono: "'Geist Mono Variable', 'Geist Mono', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace",
  },
} as const;

/** Icons: one set (lucide), one stroke width, three sizes. */
export const icon = { stroke: 1.75, size: { sm: 16, md: 20, lg: 24 } } as const;

/** Application layout constants shared by the shell and the responsive components. */
export const layout = {
  maxContentWidth: 1200,
  headerHeight: 56,
  navWidth: 208,
  navRailWidth: 72,
  bottomBarHeight: 64,
  /** Below this width the left nav collapses to an icon rail. */
  railBreakpoint: 1024,
  /** Below this width the nav becomes a bottom bar. */
  drawerBreakpoint: 768,
  /** Below this width canvases (graph) fall back to accessible lists. */
  mobileBreakpoint: 640,
} as const;
