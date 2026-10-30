/**
 * Evidence Constellation palette: the single source of truth for every semantic colour.
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

export interface Palette {
  readonly surfaces: { canvas: string; surface: string; raised: string; sunken: string };
  readonly text: { primary: string; secondary: string; muted: string; link: string };
  readonly borders: {
    /** Decorative dividers only (exempt from the 3:1 UI rule). */
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
}

const lightBrand: ToneColors = {
  fg: '#2B39B6',
  tint: '#EBECFA',
  border: '#4B55C9',
  solid: '#4B55C9',
  onSolid: '#FFFFFF',
};

const darkBrand: ToneColors = {
  fg: '#A1A7E3',
  tint: '#1D203A',
  border: '#6169CF',
  solid: '#6169CF',
  onSolid: '#FFFFFF',
};

const light: Palette = {
  surfaces: { canvas: '#F5F6FB', surface: '#FFFFFF', raised: '#FFFFFF', sunken: '#ECEEF6' },
  text: { primary: '#12172B', secondary: '#434B69', muted: '#586280', link: '#2B39B6' },
  borders: { subtle: '#DDE1EE', control: '#6F789A', focus: '#2B39B6' },
  tones: {
    brand: lightBrand,
    evidence: {
      fg: '#1163A7',
      tint: '#EBF3FA',
      border: '#1477C8',
      solid: '#1477C8',
      onSolid: '#FFFFFF',
    },
    hypothesis: {
      fg: '#6C31AF',
      tint: '#F2EBF9',
      border: '#9058D0',
      solid: '#9058D0',
      onSolid: '#FFFFFF',
    },
    productive: {
      fg: '#1C6E48',
      tint: '#EBFAF3',
      border: '#218355',
      solid: '#218355',
      onSolid: '#FFFFFF',
    },
    uncertain: {
      fg: '#845606',
      tint: '#FAF4EB',
      border: '#BA7908',
      solid: '#BA7908',
      onSolid: '#0B1020',
    },
    unsupported: {
      fg: '#B62531',
      tint: '#FAEBEC',
      border: '#D63845',
      solid: '#D63845',
      onSolid: '#FFFFFF',
    },
    missing: {
      fg: '#586074',
      tint: '#F0F2F4',
      border: '#69748C',
      solid: '#69748C',
      onSolid: '#FFFFFF',
    },
    simulated: {
      fg: '#A72F83',
      tint: '#F9EBF5',
      border: '#C7389C',
      solid: '#C7389C',
      onSolid: '#FFFFFF',
    },
    skill: {
      fg: '#106A64',
      tint: '#EBFAF9',
      border: '#138179',
      solid: '#138179',
      onSolid: '#FFFFFF',
    },
    actual: {
      fg: '#232A47',
      tint: '#EEF0F7',
      border: '#323A5E',
      solid: '#323A5E',
      onSolid: '#FFFFFF',
    },
    fork: lightBrand,
    neutral: {
      fg: '#4F5772',
      tint: '#F0F1F5',
      border: '#69748C',
      solid: '#69748C',
      onSolid: '#FFFFFF',
    },
  },
  series: ['#4B55C9', '#1477C8', '#9058D0', '#218355', '#BA7908', '#C7389C'],
  scrim: 'rgba(18, 23, 43, 0.48)',
  shadow: {
    low: '0 1px 2px rgba(18, 23, 43, 0.06), 0 1px 3px rgba(18, 23, 43, 0.08)',
    high: '0 12px 32px rgba(18, 23, 43, 0.14), 0 2px 6px rgba(18, 23, 43, 0.08)',
  },
};

const dark: Palette = {
  surfaces: { canvas: '#0B1020', surface: '#111830', raised: '#182142', sunken: '#080C1A' },
  text: { primary: '#EEF1FB', secondary: '#B8C0DA', muted: '#9BA5C6', link: '#A1A7E3' },
  borders: { subtle: '#242E52', control: '#7D88AB', focus: '#AEB6FF' },
  tones: {
    brand: darkBrand,
    evidence: {
      fg: '#7DB8E8',
      tint: '#192D3E',
      border: '#1876C3',
      solid: '#1876C3',
      onSolid: '#FFFFFF',
    },
    hypothesis: {
      fg: '#BD9CE3',
      tint: '#2A1E39',
      border: '#9058D0',
      solid: '#9058D0',
      onSolid: '#FFFFFF',
    },
    productive: {
      fg: '#85E0B6',
      tint: '#1D3A2C',
      border: '#29A36A',
      solid: '#29A36A',
      onSolid: '#0B1020',
    },
    uncertain: {
      fg: '#E8C17D',
      tint: '#3E3019',
      border: '#B67B16',
      solid: '#B67B16',
      onSolid: '#0B1020',
    },
    unsupported: {
      fg: '#E89198',
      tint: '#3B1C1E',
      border: '#D63845',
      solid: '#D63845',
      onSolid: '#FFFFFF',
    },
    missing: {
      fg: '#ABB1BF',
      tint: '#242A40',
      border: '#69748C',
      solid: '#69748C',
      onSolid: '#FFFFFF',
    },
    simulated: {
      fg: '#E194CA',
      tint: '#391E31',
      border: '#C7389C',
      solid: '#C7389C',
      onSolid: '#FFFFFF',
    },
    skill: {
      fg: '#7DE8E1',
      tint: '#1A3D3B',
      border: '#1BB1A7',
      solid: '#1BB1A7',
      onSolid: '#0B1020',
    },
    actual: {
      fg: '#D5DAEE',
      tint: '#1C2342',
      border: '#AEB6D6',
      solid: '#AEB6D6',
      onSolid: '#0B1020',
    },
    fork: darkBrand,
    neutral: {
      fg: '#B8C0DA',
      tint: '#222845',
      border: '#7D88AB',
      solid: '#7D88AB',
      onSolid: '#0B1020',
    },
  },
  series: ['#8A92E6', '#4DA3E8', '#B58AE6', '#3FBF86', '#E0A63A', '#E06BBE'],
  scrim: 'rgba(3, 6, 15, 0.68)',
  shadow: {
    low: '0 1px 2px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.03)',
    high: '0 16px 40px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.06)',
  },
};

/** Both themes' palettes, keyed by theme name. */
export const palettes: Record<ThemeName, Palette> = { light, dark };
