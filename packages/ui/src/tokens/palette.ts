/**
 * CaseGuard palette: the single source of truth for every semantic colour.
 *
 * Restraint is the rule: neutrals, ONE calm violet-indigo accent, and green, amber and red for status only. The twelve
 * tone names of the old "Evidence Constellation" stay so call sites keep compiling, but they now point at those few
 * colours (see `TONES`): meaning is carried by icon, label, pattern and position, never by a rainbow.
 *
 * Each tone carries five roles so no component has to invent colour maths:
 *  - `fg`      text / icon colour on `surface` and on `tint` (>= 4.5:1)
 *  - `tint`    subtle background for badges and callouts
 *  - `border`  outline of a component (>= 3:1 against `surface`)
 *  - `solid`   fill for graphical objects such as nodes, bars and lines (>= 3:1 against `surface`)
 *  - `onSolid` text / icon colour placed on `solid` (>= 4.5:1)
 *
 * The values are verified for both themes by `contrast.test.ts`; change them only together with that test.
 */
export type ThemeName = 'light' | 'dark';

export const TONE_NAMES = [
  'brand',
  'evidence',
  'hypothesis',
  'productive',
  'uncertain',
  'unsupported',
  'missing',
  'simulated',
  'skill',
  'actual',
  'fork',
  'neutral',
] as const;
export type ToneName = (typeof TONE_NAMES)[number];

export const TONE_ROLES = ['fg', 'tint', 'border', 'solid', 'onSolid'] as const;
export type ToneRole = (typeof TONE_ROLES)[number];
export type ToneColors = Record<ToneRole, string>;

/** Depth and light: the glass surface, the accent glow, the page canvas gradient and the primary button fill. */
export interface Effects {
  /** Soft accent glow (a translucent colour): behind the hero, around the primary button and the focus ring. */
  readonly glow: string;
  /** Translucent card surface (used with a blur). */
  readonly glass: string;
  /** Hairline around glass. */
  readonly glassBorder: string;
  /** One-pixel light line along the top edge of a card. */
  readonly highlight: string;
  /** Page canvas wash: radial accent gradients that sit behind the content. */
  readonly aurora: string;
  /** Fill of the primary button; its lightest stop still holds 4.5:1 with white text. */
  readonly gradient: string;
}

export interface Palette {
  readonly surfaces: { canvas: string; surface: string; raised: string; sunken: string };
  readonly text: { primary: string; secondary: string; muted: string; link: string };
  readonly borders: {
    /** Decorative dividers and card edges only (exempt from the 3:1 UI rule). */
    subtle: string;
    /** Boundary of an interactive control (>= 3:1). */
    control: string;
    focus: string;
  };
  readonly tones: Record<ToneName, ToneColors>;
  /** Categorical chart series colours (>= 3:1 on `surface`); always paired with dash/marker/pattern. */
  readonly series: readonly [string, string, string, string, string, string];
  readonly scrim: string;
  readonly shadow: { low: string; high: string };
  readonly effects: Effects;
}

/** The five base colour sets of a theme; the twelve tone names are assigned from them. */
interface Base {
  readonly accent: ToneColors;
  readonly success: ToneColors;
  readonly warning: ToneColors;
  readonly danger: ToneColors;
  readonly neutral: ToneColors;
  /** The strongest neutral: what actually happened, as opposed to a simulation. */
  readonly strong: ToneColors;
}

function assignTones(base: Base): Record<ToneName, ToneColors> {
  return {
    brand: base.accent,
    fork: base.accent,
    hypothesis: base.accent,
    simulated: base.accent,
    skill: base.accent,
    productive: base.success,
    uncertain: base.warning,
    unsupported: base.danger,
    evidence: base.neutral,
    missing: base.neutral,
    neutral: base.neutral,
    actual: base.strong,
  };
}

const lightBase: Base = {
  accent: {
    fg: '#4A36C4',
    tint: '#EEEBFD',
    border: '#5B46D6',
    solid: '#5B46D6',
    onSolid: '#FFFFFF',
  },
  success: {
    fg: '#136C43',
    tint: '#E8F6EE',
    border: '#1A8052',
    solid: '#1A8052',
    onSolid: '#FFFFFF',
  },
  warning: {
    fg: '#855A06',
    tint: '#FBF3E1',
    border: '#B97E0B',
    solid: '#B97E0B',
    onSolid: '#14100A',
  },
  danger: {
    fg: '#B0262C',
    tint: '#FCEBEC',
    border: '#D13C42',
    solid: '#D13C42',
    onSolid: '#FFFFFF',
  },
  neutral: {
    fg: '#4B4859',
    tint: '#EFEEF4',
    border: '#706D85',
    solid: '#706D85',
    onSolid: '#FFFFFF',
  },
  strong: {
    fg: '#17151F',
    tint: '#E9E8EF',
    border: '#454253',
    solid: '#454253',
    onSolid: '#FFFFFF',
  },
};

const darkBase: Base = {
  accent: {
    fg: '#B9AFFF',
    tint: '#26213F',
    border: '#8878F3',
    solid: '#7060E8',
    onSolid: '#FFFFFF',
  },
  success: {
    fg: '#74DFA6',
    tint: '#14291E',
    border: '#2FA56A',
    solid: '#35B277',
    onSolid: '#08130D',
  },
  warning: {
    fg: '#F0C36C',
    tint: '#2E2411',
    border: '#D6A035',
    solid: '#DCAA3F',
    onSolid: '#14100A',
  },
  danger: {
    fg: '#F59A9D',
    tint: '#35191C',
    border: '#D43A40',
    solid: '#D43A40',
    onSolid: '#FFFFFF',
  },
  neutral: {
    fg: '#C9C7D2',
    tint: '#272630',
    border: '#7B7888',
    solid: '#7B7888',
    onSolid: '#0E0D12',
  },
  strong: {
    fg: '#F5F4F7',
    tint: '#2B2A35',
    border: '#E4E2EA',
    solid: '#E4E2EA',
    onSolid: '#0E0D12',
  },
};

const light: Palette = {
  surfaces: { canvas: '#F6F5FA', surface: '#FFFFFF', raised: '#FFFFFF', sunken: '#EEEDF4' },
  text: { primary: '#17151F', secondary: '#454253', muted: '#5F5C6E', link: '#4A36C4' },
  borders: { subtle: 'rgba(23, 21, 31, 0.10)', control: '#7C7990', focus: '#4A36C4' },
  tones: assignTones(lightBase),
  series: ['#5B46D6', '#8A78EE', '#454253', '#7C7990', '#4A36C4', '#706D85'],
  scrim: 'rgba(23, 21, 31, 0.42)',
  shadow: {
    low: '0 1px 2px rgba(23, 21, 31, 0.05), 0 1px 1px rgba(23, 21, 31, 0.03)',
    high: '0 24px 56px -16px rgba(23, 21, 31, 0.22), 0 0 0 1px rgba(23, 21, 31, 0.06)',
  },
  effects: {
    glow: 'rgba(91, 70, 214, 0.18)',
    glass: 'rgba(255, 255, 255, 0.78)',
    glassBorder: 'rgba(23, 21, 31, 0.08)',
    highlight: 'rgba(255, 255, 255, 0.9)',
    aurora:
      'radial-gradient(60% 50% at 50% 0%, rgba(91, 70, 214, 0.10) 0%, rgba(91, 70, 214, 0) 70%), radial-gradient(40% 40% at 92% 8%, rgba(138, 120, 238, 0.08) 0%, rgba(138, 120, 238, 0) 70%)',
    gradient: 'linear-gradient(180deg, #6652E0 0%, #5B46D6 100%)',
  },
};

const dark: Palette = {
  surfaces: { canvas: '#131218', surface: '#1B1B22', raised: '#23232C', sunken: '#0E0D12' },
  text: { primary: '#F5F4F7', secondary: '#C9C7D2', muted: '#A3A1AD', link: '#B9AFFF' },
  borders: { subtle: 'rgba(245, 244, 247, 0.08)', control: '#7B7888', focus: '#B9AFFF' },
  tones: assignTones(darkBase),
  series: ['#B9AFFF', '#8878F3', '#E4E2EA', '#A3A1AD', '#D6D0FF', '#7B7888'],
  scrim: 'rgba(8, 7, 12, 0.72)',
  shadow: {
    low: '0 1px 2px rgba(0, 0, 0, 0.30)',
    high: '0 24px 64px -16px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(245, 244, 247, 0.08)',
  },
  effects: {
    glow: 'rgba(112, 96, 232, 0.35)',
    glass: 'rgba(27, 27, 34, 0.72)',
    glassBorder: 'rgba(245, 244, 247, 0.08)',
    highlight: 'rgba(255, 255, 255, 0.05)',
    aurora:
      'radial-gradient(60% 50% at 50% 0%, rgba(112, 96, 232, 0.20) 0%, rgba(112, 96, 232, 0) 70%), radial-gradient(40% 40% at 92% 8%, rgba(138, 120, 243, 0.10) 0%, rgba(138, 120, 243, 0) 70%)',
    gradient: 'linear-gradient(180deg, #7060E8 0%, #5D4DD8 100%)',
  },
};

/** Both themes' palettes, keyed by theme name. */
export const palettes: Record<ThemeName, Palette> = { light, dark };
