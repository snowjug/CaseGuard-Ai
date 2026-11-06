import { TONE_NAMES, palettes, type ThemeName } from './palette';
import { getCaseGuardTheme, type CaseGuardTheme } from './themes';

/** WCAG 2.2 AA minimums: normal text 4.5:1, large text and UI components / graphical objects 3:1. */
export const WCAG_AA = { text: 4.5, largeText: 3, ui: 3 } as const;
export type ContrastKind = 'text' | 'ui';

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTIONAL = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i;

/** Parses `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()`; throws on anything else. */
export function parseColor(input: string): Rgba {
  const value = input.trim();
  const hex = HEX.exec(value);
  if (hex?.[1]) {
    let digits = hex[1];
    if (digits.length <= 4) digits = [...digits].map((d) => d + d).join('');
    const n = (offset: number): number => Number.parseInt(digits.slice(offset, offset + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: digits.length === 8 ? n(6) / 255 : 1 };
  }
  const fn = FUNCTIONAL.exec(value);
  if (fn?.[1] && fn[2] && fn[3]) {
    const alphaText = fn[4];
    const alpha =
      alphaText === undefined
        ? 1
        : alphaText.endsWith('%')
          ? Number.parseFloat(alphaText) / 100
          : Number.parseFloat(alphaText);
    return {
      r: Number.parseFloat(fn[1]),
      g: Number.parseFloat(fn[2]),
      b: Number.parseFloat(fn[3]),
      a: alpha,
    };
  }
  throw new Error(`Unsupported colour "${input}"`);
}

/** Alpha-composites `top` over an opaque `bottom`. */
export function compositeOver(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a;
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  };
}

const channel = (value: number): number => {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance of an opaque colour. */
export function relativeLuminance(color: Rgba): number {
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/**
 * WCAG contrast ratio between a foreground and a background. Translucent colours are composited:
 * the background over `backdrop` (default white) and the foreground over the result.
 */
export function contrastRatio(
  foreground: string,
  background: string,
  backdrop = '#FFFFFF',
): number {
  const base = parseColor(backdrop);
  const bg = compositeOver(parseColor(background), { ...base, a: 1 });
  const fg = compositeOver(parseColor(foreground), bg);
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

export interface ContrastPair {
  id: string;
  foreground: string;
  background: string;
  kind: ContrastKind;
  /** Minimum ratio required for the pair. */
  min: number;
}

export interface ContrastResult extends ContrastPair {
  ratio: number;
  passes: boolean;
}

/** Evaluates one pair against its minimum. */
export function evaluatePair(pair: ContrastPair): ContrastResult {
  const ratio = contrastRatio(pair.foreground, pair.background);
  return { ...pair, ratio, passes: ratio >= pair.min };
}

const textPair = (id: string, foreground: string, background: string): ContrastPair => ({
  id,
  foreground,
  background,
  kind: 'text',
  min: WCAG_AA.text,
});
const uiPair = (id: string, foreground: string, background: string): ContrastPair => ({
  id,
  foreground,
  background,
  kind: 'ui',
  min: WCAG_AA.ui,
});

/**
 * Every foreground/background token pair that components actually render in `theme`:
 * CaseGuard semantic tokens (text on surfaces, tone roles, control borders, focus, chart series)
 * plus the Fluent tokens the primitives rely on (neutral text, brand links and buttons, accessible strokes).
 */
export function getContrastPairs(theme: ThemeName): ContrastPair[] {
  const p = palettes[theme];
  const fluent: CaseGuardTheme = getCaseGuardTheme(theme);
  const surfaces = Object.entries(p.surfaces);
  const pairs: ContrastPair[] = [];

  for (const [surfaceName, surface] of surfaces) {
    for (const [role, color] of Object.entries(p.text)) {
      pairs.push(textPair(`text.${role} on ${surfaceName}`, color, surface));
    }
    pairs.push(uiPair(`border.control on ${surfaceName}`, p.borders.control, surface));
    pairs.push(uiPair(`border.focus on ${surfaceName}`, p.borders.focus, surface));
  }

  for (const tone of TONE_NAMES) {
    const t = p.tones[tone];
    for (const [surfaceName, surface] of surfaces) {
      pairs.push(textPair(`tone.${tone}.fg on ${surfaceName}`, t.fg, surface));
    }
    pairs.push(textPair(`tone.${tone}.fg on tint`, t.fg, t.tint));
    if (tone === 'brand') {
      // The accent tint is the selected state of rows (palette, persona picker, navigation): primary and secondary text sit on it.
      pairs.push(textPair('text.primary on tone.brand.tint', p.text.primary, t.tint));
      pairs.push(textPair('text.secondary on tone.brand.tint', p.text.secondary, t.tint));
    }
    pairs.push(textPair(`tone.${tone}.onSolid on solid`, t.onSolid, t.solid));
    for (const surfaceName of ['canvas', 'surface', 'raised'] as const) {
      pairs.push(
        uiPair(`tone.${tone}.border on ${surfaceName}`, t.border, p.surfaces[surfaceName]),
      );
      pairs.push(uiPair(`tone.${tone}.solid on ${surfaceName}`, t.solid, p.surfaces[surfaceName]));
    }
  }

  p.series.forEach((color, index) => {
    for (const surfaceName of ['canvas', 'surface', 'raised'] as const) {
      pairs.push(uiPair(`series.${index + 1} on ${surfaceName}`, color, p.surfaces[surfaceName]));
    }
  });

  const fluentBackgrounds = [
    'colorNeutralBackground1',
    'colorNeutralBackground2',
    'colorNeutralBackground3',
  ] as const;
  for (const bg of fluentBackgrounds) {
    for (const fg of [
      'colorNeutralForeground1',
      'colorNeutralForeground2',
      'colorNeutralForeground3',
      'colorNeutralForeground4',
      'colorBrandForeground1',
      'colorBrandForegroundLink',
      'colorPaletteRedForeground1',
      'colorPaletteGreenForeground1',
    ] as const) {
      pairs.push(textPair(`fluent ${fg} on ${bg}`, fluent[fg], fluent[bg]));
    }
    pairs.push(
      uiPair(
        `fluent colorNeutralStrokeAccessible on ${bg}`,
        fluent.colorNeutralStrokeAccessible,
        fluent[bg],
      ),
    );
    pairs.push(
      uiPair(`fluent colorNeutralStroke1 on ${bg}`, fluent.colorNeutralStroke1, fluent[bg]),
    );
  }
  for (const bg of ['colorBrandBackground', 'colorBrandBackgroundHover'] as const) {
    pairs.push(
      textPair(
        `fluent colorNeutralForegroundOnBrand on ${bg}`,
        fluent.colorNeutralForegroundOnBrand,
        fluent[bg],
      ),
    );
  }
  pairs.push(
    uiPair(
      'fluent colorStrokeFocus2 on colorNeutralBackground1',
      fluent.colorStrokeFocus2,
      fluent.colorNeutralBackground1,
    ),
  );
  pairs.push(
    uiPair(
      'fluent colorBrandBackground on colorNeutralBackground1',
      fluent.colorBrandBackground,
      fluent.colorNeutralBackground1,
    ),
  );

  return pairs;
}
