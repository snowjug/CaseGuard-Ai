import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { motion, palettes, radius, space } from '../src/tokens';

// `fileURLToPath` on the string avoids jsdom's global URL class, which `readFileSync` rejects.
const css = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/styles/globals.css'),
  'utf8',
);

const declared = (name: string, block = css): string | undefined =>
  new RegExp(`${name}:\\s*([^;]+);`, 'i').exec(block)?.[1]?.trim();
const section = (selector: string): string => {
  const start = css.indexOf(selector);
  expect(start, `missing ${selector}`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('}', start));
};

describe('globals.css stays in sync with the design tokens', () => {
  it('declares the 4-pt spacing scale and radii', () => {
    for (const [step, value] of Object.entries(space)) {
      expect(declared(`--cg-space-${step}`)).toBe(`${value}px`);
    }
    expect(declared('--cg-radius-lg')).toBe(`${radius.lg}px`);
    expect(declared('--cg-radius-md')).toBe(`${radius.md}px`);
    expect(declared('--cg-radius-sm')).toBe(`${radius.sm}px`);
  });

  it('declares the motion durations and easing (150-250 ms, ease-out)', () => {
    expect(declared('--cg-motion-fast')).toBe(`${motion.fast}ms`);
    expect(declared('--cg-motion-base')).toBe(`${motion.base}ms`);
    expect(declared('--cg-motion-slow')).toBe(`${motion.slow}ms`);
    expect(declared('--cg-motion-easing')).toBe(motion.easing);
    expect(motion.fast).toBeGreaterThanOrEqual(150);
    expect(motion.slow).toBeLessThanOrEqual(250);
  });

  it('paints the page canvas from the palette in both themes and for system mode', () => {
    expect(declared('--cg-canvas', section(':root {'))?.toLowerCase()).toBe(
      palettes.light.surfaces.canvas.toLowerCase(),
    );
    expect(declared('--cg-canvas', section(":root[data-cg-theme='dark']"))?.toLowerCase()).toBe(
      palettes.dark.surfaces.canvas.toLowerCase(),
    );
    expect(declared('--cg-canvas', section("  :root[data-cg-theme='system']"))?.toLowerCase()).toBe(
      palettes.dark.surfaces.canvas.toLowerCase(),
    );
  });

  it('suppresses animation for reduced motion (OS setting and manual override) and offers a motion-safe utility', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain("html[data-cg-reduced-motion='true']");
    expect(css).toContain("html:not([data-cg-reduced-motion='false'])");
    expect(css).toContain('.cg-motion-safe');
    expect(css).toContain('animation-duration: 0.001ms !important');
  });
});
