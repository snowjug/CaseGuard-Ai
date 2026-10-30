/** Theme-independent design tokens: 4-pt spacing, radii, motion, typography and layout. */

/** 4-pt spacing scale in px (4/8/12/16/24/32). */
export const space = { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 } as const;
export type SpaceStep = keyof typeof space;

/** Corner radii in px. Cards use `lg` (12 px). */
export const radius = { none: 0, sm: 6, md: 8, lg: 12, pill: 999 } as const;

export const borderWidth = { thin: 1, thick: 2, focus: 3 } as const;

/**
 * Motion: 150-250 ms, ease-out, purposeful only (focus, expand, graph path reveal).
 * Components must also honour `prefers-reduced-motion` and the in-app override (see `useReducedMotion`).
 */
export const motion = {
  fast: 150,
  base: 200,
  slow: 250,
  easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
} as const;

/** Type scale in px. Body is never below 14 px and captions never below 12 px. */
export const typography = {
  size: {
    caption: 12,
    body: 14,
    bodyLarge: 16,
    subtitle: 18,
    title3: 20,
    title2: 24,
    title1: 28,
    metric: 32,
  },
  weight: { regular: 400, medium: 500, semibold: 600, bold: 700 },
  lineHeight: { tight: 1.25, normal: 1.5, relaxed: 1.6 },
  /** Fluent default font stacks (Segoe UI Variable first); tabular figures are applied per component. */
  family: {
    base: "'Segoe UI Variable Text', 'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif",
    mono: "'Cascadia Code', Consolas, 'SFMono-Regular', Menlo, monospace",
  },
} as const;

/** Application layout constants shared by the shell and the responsive components. */
export const layout = {
  maxContentWidth: 1440,
  headerHeight: 56,
  navWidth: 248,
  navRailWidth: 64,
  /** Below this width the left nav collapses to an icon rail. */
  railBreakpoint: 1100,
  /** Below this width the nav becomes a drawer. */
  drawerBreakpoint: 720,
  /** Below this width canvases (graph) fall back to accessible lists. */
  mobileBreakpoint: 640,
} as const;
