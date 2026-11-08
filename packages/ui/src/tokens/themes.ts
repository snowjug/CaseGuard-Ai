import { createDarkTheme, createLightTheme, type Theme } from '@fluentui/react-components';
import { caseguardBrand } from './brand';
import { buildCustomTokens, type CustomTokens } from './cg';
import { palettes, type Palette, type ThemeName, type ToneColors } from './palette';
import { motion, typography } from './static';

/** A Fluent theme extended with the CaseGuard semantic tokens (emitted as `--cg*` CSS variables). */
export type CaseGuardTheme = Theme & CustomTokens;

export interface ThemeOptions {
  /** Presentation mode enlarges type slightly for projectors. */
  presentation?: boolean;
}

/** Neutral-scale states and the few Fluent neutrals the palette does not name. All are tinted toward the accent hue. */
const variants = {
  light: {
    hover: '#F4F3F9',
    pressed: '#ECEAF3',
    selected: '#ECE9FB',
    background2: '#FAF9FC',
    background4: '#F1F0F6',
    background6: '#E8E6EF',
    disabled: '#F1F0F6',
    inverted: '#17151F',
    foregroundInverted: '#FFFFFF',
    foregroundDisabled: '#9D9AAD',
    stroke1Hover: '#6A677D',
    stroke1Pressed: '#5A576D',
    stroke3: '#ECEAF2',
    strokeDisabled: '#DAD8E3',
    shadowAmbient: 'rgba(23, 21, 31, 0.10)',
    shadowKey: 'rgba(23, 21, 31, 0.12)',
    shadowAmbientLighter: 'rgba(23, 21, 31, 0.05)',
    shadowKeyLighter: 'rgba(23, 21, 31, 0.06)',
  },
  dark: {
    hover: '#25242E',
    pressed: '#1F1E27',
    selected: '#2B2940',
    background2: '#16151C',
    background4: '#100F14',
    background6: '#23232C',
    disabled: '#1B1B22',
    inverted: '#F5F4F7',
    foregroundInverted: '#0E0D12',
    foregroundDisabled: '#5F5C6E',
    stroke1Hover: '#928FA2',
    stroke1Pressed: '#A3A1AD',
    stroke3: '#24232C',
    strokeDisabled: '#2C2B36',
    shadowAmbient: 'rgba(0, 0, 0, 0.40)',
    shadowKey: 'rgba(0, 0, 0, 0.48)',
    shadowAmbientLighter: 'rgba(0, 0, 0, 0.30)',
    shadowKeyLighter: 'rgba(0, 0, 0, 0.36)',
  },
} as const;

function neutralOverrides(name: ThemeName, p: Palette): Partial<Theme> {
  const v = variants[name];
  return {
    colorNeutralBackground1: p.surfaces.surface,
    colorNeutralBackground1Hover: v.hover,
    colorNeutralBackground1Pressed: v.pressed,
    colorNeutralBackground1Selected: v.selected,
    colorNeutralBackground2: v.background2,
    colorNeutralBackground2Hover: v.hover,
    colorNeutralBackground2Pressed: v.pressed,
    colorNeutralBackground2Selected: v.selected,
    colorNeutralBackground3: p.surfaces.canvas,
    colorNeutralBackground3Hover: v.hover,
    colorNeutralBackground3Pressed: v.pressed,
    colorNeutralBackground3Selected: v.selected,
    colorNeutralBackground4: v.background4,
    colorNeutralBackground5: p.surfaces.sunken,
    colorNeutralBackground6: v.background6,
    colorSubtleBackgroundHover: v.hover,
    colorSubtleBackgroundPressed: v.pressed,
    colorSubtleBackgroundSelected: v.selected,
    colorNeutralBackgroundDisabled: v.disabled,
    colorNeutralBackgroundInverted: v.inverted,
    colorNeutralBackgroundStatic: '#1C1A28',
    colorBackgroundOverlay: p.scrim,
    colorNeutralForeground1: p.text.primary,
    colorNeutralForeground1Hover: p.text.primary,
    colorNeutralForeground1Pressed: p.text.primary,
    colorNeutralForeground1Selected: p.text.primary,
    colorNeutralForeground2: p.text.secondary,
    colorNeutralForeground2Hover: p.text.primary,
    colorNeutralForeground2Pressed: p.text.primary,
    colorNeutralForeground2Selected: p.text.primary,
    colorNeutralForeground3: p.text.muted,
    colorNeutralForeground3Hover: p.text.secondary,
    colorNeutralForeground3Pressed: p.text.secondary,
    colorNeutralForeground3Selected: p.text.secondary,
    colorNeutralForeground4: p.text.muted,
    colorNeutralForegroundDisabled: v.foregroundDisabled,
    colorNeutralForegroundInverted: v.foregroundInverted,
    colorNeutralStroke1: p.borders.control,
    colorNeutralStroke1Hover: v.stroke1Hover,
    colorNeutralStroke1Pressed: v.stroke1Pressed,
    colorNeutralStroke1Selected: v.stroke1Hover,
    colorNeutralStroke2: p.borders.subtle,
    colorNeutralStroke3: v.stroke3,
    colorNeutralStrokeSubtle: p.borders.subtle,
    colorNeutralStrokeAccessible: p.borders.control,
    colorNeutralStrokeAccessibleHover: v.stroke1Hover,
    colorNeutralStrokeAccessiblePressed: v.stroke1Pressed,
    colorNeutralStrokeDisabled: v.strokeDisabled,
    colorStrokeFocus1: p.surfaces.surface,
    colorStrokeFocus2: p.borders.focus,
    colorNeutralShadowAmbient: v.shadowAmbient,
    colorNeutralShadowKey: v.shadowKey,
    colorNeutralShadowAmbientLighter: v.shadowAmbientLighter,
    colorNeutralShadowKeyLighter: v.shadowKeyLighter,
  };
}

/**
 * Brand roles, set explicitly from the accent tone. Fluent's own dark defaults fill primary buttons with a shade that
 * is only 2.3:1 against the dark surface, and a lighter hover would drop white label text below 4.5:1, so in the dark
 * theme hover and pressed get darker, never lighter.
 */
const brandOverrides: Record<ThemeName, Partial<Theme>> = {
  light: {
    colorBrandBackground: '#5B46D6',
    colorBrandBackgroundHover: '#4F3BC9',
    colorBrandBackgroundPressed: '#4330B8',
    colorBrandBackgroundSelected: '#5B46D6',
    colorBrandBackground2: '#EEEBFD',
    colorBrandBackground2Hover: '#E3DEFB',
    colorBrandBackground2Pressed: '#D5CFF7',
    colorBrandForeground1: '#4A36C4',
    colorBrandForeground2: '#4A36C4',
    colorBrandForegroundLink: '#4A36C4',
    colorBrandForegroundLinkHover: '#3B29A8',
    colorBrandForegroundLinkPressed: '#2F2087',
    colorBrandForegroundLinkSelected: '#4A36C4',
    colorBrandStroke1: '#5B46D6',
    colorBrandStroke2: '#D5CFF7',
    colorCompoundBrandBackground: '#5B46D6',
    colorCompoundBrandBackgroundHover: '#4F3BC9',
    colorCompoundBrandBackgroundPressed: '#4330B8',
    colorCompoundBrandForeground1: '#4A36C4',
    colorCompoundBrandForeground1Hover: '#3B29A8',
    colorCompoundBrandForeground1Pressed: '#2F2087',
    colorCompoundBrandStroke: '#5B46D6',
    colorCompoundBrandStrokeHover: '#4F3BC9',
    colorCompoundBrandStrokePressed: '#4330B8',
  },
  dark: {
    colorBrandBackground: '#7060E8',
    colorBrandBackgroundHover: '#6455DD',
    colorBrandBackgroundPressed: '#5849CF',
    colorBrandBackgroundSelected: '#6A5AE2',
    colorBrandBackground2: '#26213F',
    colorBrandBackground2Hover: '#2E2850',
    colorBrandBackground2Pressed: '#1D1930',
    colorBrandForeground1: '#B9AFFF',
    colorBrandForeground2: '#B9AFFF',
    colorBrandForegroundLink: '#B9AFFF',
    colorBrandForegroundLinkHover: '#D0C9FF',
    colorBrandForegroundLinkPressed: '#A99EFF',
    colorBrandForegroundLinkSelected: '#B9AFFF',
    colorBrandStroke1: '#8878F3',
    colorBrandStroke2: '#3A3166',
    colorCompoundBrandBackground: '#7060E8',
    colorCompoundBrandBackgroundHover: '#6455DD',
    colorCompoundBrandBackgroundPressed: '#5849CF',
    colorCompoundBrandForeground1: '#B9AFFF',
    colorCompoundBrandForeground1Hover: '#D0C9FF',
    colorCompoundBrandForeground1Pressed: '#A99EFF',
    colorCompoundBrandStroke: '#8878F3',
    colorCompoundBrandStrokeHover: '#A99EFF',
    colorCompoundBrandStrokePressed: '#B9AFFF',
  },
};

/** Fluent's status palettes (message bars, alerts, inline validation) follow the three status tones. */
function statusPalette(name: 'Red' | 'Green' | 'Yellow', tone: ToneColors): Partial<Theme> {
  return {
    [`colorPalette${name}Foreground1`]: tone.fg,
    [`colorPalette${name}Foreground2`]: tone.fg,
    [`colorPalette${name}Background1`]: tone.tint,
    [`colorPalette${name}Background2`]: tone.tint,
    [`colorPalette${name}Background3`]: tone.solid,
    [`colorPalette${name}Border1`]: tone.border,
    [`colorPalette${name}Border2`]: tone.solid,
  };
}

/** Corner radii of Fluent's own components (the kit uses the scale in `static.ts` directly): 12 for controls, 24 for dialogs. */
const shapeOverrides: Partial<Theme> = {
  borderRadiusNone: '0',
  borderRadiusSmall: '4px',
  borderRadiusMedium: '12px',
  borderRadiusLarge: '16px',
  borderRadiusXLarge: '24px',
  borderRadius2XLarge: '24px',
  borderRadius3XLarge: '24px',
  borderRadius4XLarge: '24px',
};

/** Geist at the type scale of `static.ts`: body 15, caption 13, h2 22, h1 30, display 48. */
const typographyOverrides: Partial<Theme> = {
  fontFamilyBase: typography.family.base,
  fontFamilyMonospace: typography.family.mono,
  fontFamilyNumeric: typography.family.base,
  fontSizeBase100: '12px',
  fontSizeBase200: '13px',
  fontSizeBase300: '15px',
  fontSizeBase400: '18px',
  fontSizeBase500: '22px',
  fontSizeBase600: '26px',
  fontSizeHero700: '30px',
  fontSizeHero800: '40px',
  fontSizeHero900: '48px',
  fontSizeHero1000: '56px',
  lineHeightBase100: '16px',
  lineHeightBase200: '18px',
  lineHeightBase300: '23px',
  lineHeightBase400: '24px',
  lineHeightBase500: '28px',
  lineHeightBase600: '32px',
  lineHeightHero700: '34px',
  lineHeightHero800: '44px',
  lineHeightHero900: '52px',
  lineHeightHero1000: '60px',
  fontWeightRegular: typography.weight.regular,
  fontWeightMedium: typography.weight.medium,
  fontWeightSemibold: typography.weight.semibold,
  fontWeightBold: typography.weight.bold,
};

/** Fluent's own motion follows the same ease-out and never runs longer than 300 ms. */
const motionOverrides: Partial<Theme> = {
  durationUltraFast: '50ms',
  durationFaster: '100ms',
  durationFast: `${motion.fast}ms`,
  durationNormal: `${motion.base}ms`,
  durationGentle: `${motion.slow}ms`,
  durationSlow: `${motion.max}ms`,
  durationSlower: `${motion.max}ms`,
  durationUltraSlow: `${motion.max}ms`,
  curveDecelerateMax: motion.easing,
  curveDecelerateMid: motion.easing,
  curveDecelerateMin: motion.easing,
  curveEasyEaseMax: motion.easing,
  curveEasyEase: motion.easing,
};

/** Depth without weight: a hairline on small surfaces, one soft lift for overlays. */
function shadowOverrides(p: Palette): Partial<Theme> {
  return {
    shadow2: p.shadow.low,
    shadow4: p.shadow.low,
    shadow8: p.shadow.low,
    shadow16: p.shadow.high,
    shadow28: p.shadow.high,
    shadow64: p.shadow.high,
  };
}

/** Presentation mode: +2 px body and heading sizes so the UI reads from the back of a room. */
const presentationOverrides: Partial<Theme> = {
  fontSizeBase200: '15px',
  fontSizeBase300: '17px',
  fontSizeBase400: '20px',
  fontSizeBase500: '24px',
  fontSizeBase600: '28px',
  fontSizeHero700: '34px',
  fontSizeHero800: '44px',
  fontSizeHero900: '52px',
  lineHeightBase200: '20px',
  lineHeightBase300: '26px',
  lineHeightBase400: '26px',
  lineHeightBase500: '30px',
  lineHeightBase600: '34px',
  lineHeightHero700: '40px',
  lineHeightHero800: '50px',
  lineHeightHero900: '58px',
};

/** Builds a CaseGuard theme: Fluent base from the brand ramp, tinted neutrals, then the semantic tokens. */
export function getCaseGuardTheme(name: ThemeName, options: ThemeOptions = {}): CaseGuardTheme {
  const palette = palettes[name];
  const base =
    name === 'light' ? createLightTheme(caseguardBrand) : createDarkTheme(caseguardBrand);
  return {
    ...base,
    ...neutralOverrides(name, palette),
    ...brandOverrides[name],
    ...statusPalette('Red', palette.tones.unsupported),
    ...statusPalette('Green', palette.tones.productive),
    ...statusPalette('Yellow', palette.tones.uncertain),
    ...shapeOverrides,
    ...typographyOverrides,
    ...motionOverrides,
    ...shadowOverrides(palette),
    ...(options.presentation ? presentationOverrides : {}),
    ...buildCustomTokens(palette),
  };
}

export const caseguardLightTheme: CaseGuardTheme = getCaseGuardTheme('light');
export const caseguardDarkTheme: CaseGuardTheme = getCaseGuardTheme('dark');

/**
 * CSS that re-declares every dark-theme token that differs from light, inside a `prefers-color-scheme: dark`
 * query. Server-rendering `system` mode with the light theme plus this block removes the flash for dark users
 * before hydration resolves the real preference. Specificity (`html .cg-theme-system`) beats FluentProvider's rule.
 */
export function createSystemThemeCss(options: ThemeOptions = {}): string {
  const light = getCaseGuardTheme('light', options);
  const dark = getCaseGuardTheme('dark', options);
  const declarations = (Object.keys(dark) as (keyof CaseGuardTheme)[])
    .filter((key) => dark[key] !== light[key])
    .map((key) => `--${key}:${String(dark[key])};`)
    .join('');
  return `@media (prefers-color-scheme: dark){html .cg-theme-system{${declarations}}}`;
}
