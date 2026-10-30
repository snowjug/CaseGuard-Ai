import { describe, expect, it } from 'vitest';
import { TONE_NAMES, TONE_ROLES, palettes, type ThemeName } from './palette';
import {
  WCAG_AA,
  compositeOver,
  contrastRatio,
  evaluatePair,
  getContrastPairs,
  parseColor,
  relativeLuminance,
} from './contrast';
import { cg, buildCustomTokens, toneTokenKey } from './cg';
import {
  caseguardDarkTheme,
  caseguardLightTheme,
  createSystemThemeCss,
  getCaseGuardTheme,
} from './themes';

describe('contrast maths', () => {
  it('computes the WCAG reference ratios', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    // #767676 on white is the well-known 4.54:1 AA boundary.
    expect(contrastRatio('#767676', '#FFFFFF')).toBeGreaterThan(4.5);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeLessThan(4.6);
  });

  it('parses hex, short hex, rgb() and rgba()', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('#00000080').a).toBeCloseTo(0.502, 2);
    expect(parseColor('rgb(18, 23, 43)')).toEqual({ r: 18, g: 23, b: 43, a: 1 });
    expect(parseColor('rgba(0, 0, 0, 0.5)').a).toBe(0.5);
    expect(() => parseColor('hotpink')).toThrow(/Unsupported colour/);
  });

  it('composites translucent colours over their backdrop', () => {
    const over = compositeOver({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 });
    expect(over.r).toBeCloseTo(127.5, 5);
    expect(relativeLuminance({ r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(1, 5);
    // Semi-transparent black text over white is lighter than opaque black.
    expect(contrastRatio('rgba(0,0,0,0.5)', '#FFFFFF')).toBeLessThan(contrastRatio('#000', '#FFF'));
  });
});

describe.each<ThemeName>(['light', 'dark'])(
  '[NFR-A11Y-01] WCAG 2.2 AA token contrast (%s theme)',
  (theme) => {
    const pairs = getContrastPairs(theme);

    it('covers every tone role, text role, control border, focus ring and chart series', () => {
      expect(pairs.length).toBeGreaterThan(200);
      for (const tone of TONE_NAMES) {
        expect(pairs.some((p) => p.id.startsWith(`tone.${tone}.fg on`))).toBe(true);
        expect(pairs.some((p) => p.id === `tone.${tone}.onSolid on solid`)).toBe(true);
      }
      expect(pairs.filter((p) => p.id.startsWith('series.'))).toHaveLength(18);
    });

    it('meets 4.5:1 for text and 3:1 for UI components and graphical objects on every pair', () => {
      const failures = pairs
        .map(evaluatePair)
        .filter((result) => !result.passes)
        .map(
          (r) => `${r.id}: ${r.ratio.toFixed(2)} < ${r.min} (${r.foreground} on ${r.background})`,
        );
      expect(failures).toEqual([]);
    });

    it('uses the AA thresholds for each kind', () => {
      for (const pair of pairs) {
        expect(pair.min).toBe(pair.kind === 'text' ? WCAG_AA.text : WCAG_AA.ui);
      }
    });
  },
);

describe('themes and CSS variables', () => {
  it('extends the Fluent theme with every semantic token', () => {
    for (const theme of [caseguardLightTheme, caseguardDarkTheme]) {
      for (const tone of TONE_NAMES) {
        for (const role of TONE_ROLES) {
          expect(theme[toneTokenKey(tone, role)]).toMatch(/^#[0-9A-F]{6}$/i);
        }
      }
    }
    expect(caseguardLightTheme.cgCanvas).toBe(palettes.light.surfaces.canvas);
    expect(caseguardDarkTheme.cgCanvas).toBe(palettes.dark.surfaces.canvas);
  });

  it('references tokens through CSS variables that match the emitted theme keys', () => {
    const keys = Object.keys(buildCustomTokens(palettes.light));
    expect(cg.tone.evidence.fg).toBe('var(--cgToneEvidenceFg)');
    expect(keys).toContain('cgToneEvidenceFg');
    expect(cg.tone.skill.onSolid).toBe('var(--cgToneSkillOnSolid)');
    expect(cg.series[5]).toBe('var(--cgSeries6)');
  });

  it('keeps the two themes distinct and the presentation theme larger', () => {
    expect(caseguardLightTheme.colorNeutralBackground1).not.toBe(
      caseguardDarkTheme.colorNeutralBackground1,
    );
    const presentation = getCaseGuardTheme('light', { presentation: true });
    expect(Number.parseInt(presentation.fontSizeBase300, 10)).toBeGreaterThan(
      Number.parseInt(caseguardLightTheme.fontSizeBase300, 10),
    );
  });

  it('emits a dark-mode media query that only redeclares differing tokens', () => {
    const css = createSystemThemeCss();
    expect(css.startsWith('@media (prefers-color-scheme: dark){html .cg-theme-system{')).toBe(true);
    expect(css).toContain(`--cgCanvas:${palettes.dark.surfaces.canvas};`);
    expect(css).not.toContain('--fontFamilyBase');
  });

  it('is safe to inline as the text of a <style> element (nothing React or HTML would escape)', () => {
    for (const presentation of [false, true]) {
      expect(createSystemThemeCss({ presentation })).not.toMatch(/[<>&"'\\]/);
    }
  });
});
