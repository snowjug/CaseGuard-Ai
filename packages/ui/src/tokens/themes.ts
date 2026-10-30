import { createDarkTheme, createLightTheme, type Theme } from '@fluentui/react-components';
import { caseguardBrand } from './brand';
import { buildCustomTokens, type CustomTokens } from './cg';
import { palettes, type Palette, type ThemeName } from './palette';

/** A Fluent theme extended with the CaseGuard semantic tokens (emitted as `--cg*` CSS variables). */
export type CaseGuardTheme = Theme & CustomTokens;

export interface ThemeOptions {
  /** Presentation mode enlarges type slightly for projectors. */
  presentation?: boolean;
}

/** Neutral-scale hover/pressed/selected shades. They are tinted toward the brand hue, never pure grey. */
const interaction: Record<ThemeName, Record<'hover' | 'pressed' | 'selected', string>> = {
  light: { hover: '#F1F3FA', pressed: '#E4E8F4', selected: '#E9ECF8' },
  dark: { hover: '#1D2750', pressed: '#0F1530', selected: '#222D5C' },
};

function neutralOverrides(name: ThemeName, p: Palette): Partial<Theme> {
  const state = interaction[name];
  const isLight = name === 'light';
  return {
    colorNeutralBackground1: p.surfaces.surface,
    colorNeutralBackground1Hover: state.hover,
    colorNeutralBackground1Pressed: state.pressed,
    colorNeutralBackground1Selected: state.selected,
    colorNeutralBackground2: isLight ? '#F8F9FD' : '#0E1428',
    colorNeutralBackground2Hover: state.hover,
    colorNeutralBackground2Pressed: state.pressed,
    colorNeutralBackground2Selected: state.selected,
    colorNeutralBackground3: p.surfaces.canvas,
    colorNeutralBackground3Hover: state.hover,
    colorNeutralBackground3Pressed: state.pressed,
    colorNeutralBackground3Selected: state.selected,
    colorNeutralBackground4: isLight ? '#F0F2F9' : '#0A0F1E',
    colorNeutralBackground5: p.surfaces.sunken,
    colorNeutralBackground6: isLight ? '#E4E7F2' : '#1E2749',
    colorSubtleBackgroundHover: state.hover,
    colorSubtleBackgroundPressed: state.pressed,
    colorSubtleBackgroundSelected: state.selected,
    colorNeutralBackgroundDisabled: isLight ? '#EFF1F8' : '#141B36',
    colorNeutralBackgroundInverted: isLight ? '#1C2340' : '#EEF1FB',
    colorNeutralBackgroundStatic: '#1C2340',
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
    colorNeutralForegroundDisabled: isLight ? '#9AA2BD' : '#5B6486',
    colorNeutralForegroundInverted: isLight ? '#FFFFFF' : '#0B1020',
    colorNeutralStroke1: p.borders.control,
    colorNeutralStroke1Hover: isLight ? '#5F688B' : '#9099B9',
    colorNeutralStroke1Pressed: isLight ? '#4F5878' : '#A3ACC8',
    colorNeutralStroke1Selected: isLight ? '#5F688B' : '#9099B9',
    colorNeutralStroke2: p.borders.subtle,
    colorNeutralStroke3: isLight ? '#E9ECF5' : '#1D2646',
    colorNeutralStrokeSubtle: p.borders.subtle,
    colorNeutralStrokeAccessible: p.borders.control,
    colorNeutralStrokeAccessibleHover: isLight ? '#5F688B' : '#9099B9',
    colorNeutralStrokeAccessiblePressed: isLight ? '#4F5878' : '#A3ACC8',
    colorNeutralStrokeDisabled: isLight ? '#DDE1EE' : '#2A3459',
    colorStrokeFocus1: p.surfaces.surface,
    colorStrokeFocus2: p.borders.focus,
    colorNeutralShadowAmbient: isLight ? 'rgba(18, 23, 43, 0.12)' : 'rgba(0, 0, 0, 0.4)',
    colorNeutralShadowKey: isLight ? 'rgba(18, 23, 43, 0.14)' : 'rgba(0, 0, 0, 0.48)',
    colorNeutralShadowAmbientLighter: isLight ? 'rgba(18, 23, 43, 0.06)' : 'rgba(0, 0, 0, 0.3)',
    colorNeutralShadowKeyLighter: isLight ? 'rgba(18, 23, 43, 0.07)' : 'rgba(0, 0, 0, 0.36)',
  };
}

/**
 * Fluent's dark default fills primary buttons with brand 70, which is only 2.3:1 against the dark surface.
 * Shade 90 keeps white label text at 4.7:1 and the filled shape at 3.7:1 (WCAG 1.4.11).
 */
const darkBrandOverrides: Partial<Theme> = {
  colorBrandBackground: caseguardBrand[90],
  colorBrandBackgroundHover: '#555FD2',
  colorBrandBackgroundPressed: caseguardBrand[70],
  colorBrandBackgroundSelected: caseguardBrand[80],
};

/** Slightly rounder than Fluent's defaults: 6 px controls, 12 px dialogs and cards. */
const shapeOverrides: Partial<Theme> = {
  borderRadiusSmall: '4px',
  borderRadiusMedium: '6px',
  borderRadiusLarge: '8px',
  borderRadiusXLarge: '12px',
};

/** Presentation mode: +2 px body and heading sizes so the UI reads from the back of a room. */
const presentationOverrides: Partial<Theme> = {
  fontSizeBase200: '14px',
  fontSizeBase300: '16px',
  fontSizeBase400: '18px',
  fontSizeBase500: '22px',
  fontSizeBase600: '26px',
  fontSizeHero700: '32px',
  fontSizeHero800: '38px',
  lineHeightBase200: '20px',
  lineHeightBase300: '24px',
  lineHeightBase400: '26px',
  lineHeightBase500: '30px',
  lineHeightBase600: '34px',
  lineHeightHero700: '40px',
  lineHeightHero800: '46px',
};

/** Builds a CaseGuard theme: Fluent base from the brand ramp, tinted neutrals, then the semantic tokens. */
export function getCaseGuardTheme(name: ThemeName, options: ThemeOptions = {}): CaseGuardTheme {
  const palette = palettes[name];
  const base =
    name === 'light' ? createLightTheme(caseguardBrand) : createDarkTheme(caseguardBrand);
  return {
    ...base,
    ...neutralOverrides(name, palette),
    ...(name === 'dark' ? darkBrandOverrides : {}),
    ...shapeOverrides,
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
