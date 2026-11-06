import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { palettes } from '@caseguard/ui/server';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * One source of truth for colour: `packages/ui/src/tokens/palette.ts`. Components read it through `cg.*`; nothing else
 * may carry a colour of its own. Spacing and corner radii are the same: `cg.space` and `cg.radius`. These checks keep it
 * that way.
 */

// Vitest runs from the package directory (`apps/web`), two levels below the repository root.
const ROOT = resolve(process.cwd(), '../..');

function sources(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules' && name !== '.next') found.push(...sources(path));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) found.push(path);
  }
  return found;
}

const COLOUR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/;

/** Files that may carry colour literals, and why. */
const ALLOWED = new Set([
  // The token source itself (palette, brand ramp, theme maps and the contrast maths that verifies them).
  ...['palette.ts', 'brand.ts', 'themes.ts', 'contrast.ts'].map((name) =>
    join('packages/ui/src/tokens', name),
  ),
  // A printed report is black ink on white paper in every theme; its one palette constant lives here.
  'apps/web/src/features/review/report/css.ts',
]);

describe('[UI-TOKENS-01] colours come from the palette only', () => {
  it('has no colour literal in any component or page outside the token files', () => {
    const files = [
      ...sources(join(ROOT, 'apps/web/src')),
      ...sources(join(ROOT, 'packages/ui/src')),
    ].map((path) => relative(ROOT, path));
    const offenders = files
      .filter((file) => !ALLOWED.has(file))
      .filter((file) => COLOUR.test(readFileSync(join(ROOT, file), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('keeps the printed report to one palette constant of plain black, white and grey', () => {
    const css = readFileSync(join(ROOT, 'apps/web/src/features/review/report/css.ts'), 'utf8');
    const literals = css.match(new RegExp(COLOUR.source, 'g')) ?? [];
    expect(literals.length).toBeLessThanOrEqual(4);
    expect(css).toMatch(/const PAPER = \{/);
  });
});

describe('[UI-TOKENS-02] the stylesheet repeats no colour the palette does not have', () => {
  const css = readFileSync(join(ROOT, 'packages/ui/src/styles/globals.css'), 'utf8');
  const known = new Set(
    Object.values(palettes).flatMap((palette) => {
      const values: string[] = [
        ...Object.values(palette.surfaces),
        ...Object.values(palette.text),
        ...Object.values(palette.borders),
        ...Object.values(palette.series),
        ...Object.values(palette.tones).flatMap((tone) => Object.values(tone)),
      ];
      return values.map((value) => value.toLowerCase());
    }),
  );

  it('uses only palette colours for the page chrome and the fallbacks', () => {
    const literals = (css.match(/#[0-9a-fA-F]{6}\b/g) ?? []).map((value) => value.toLowerCase());
    expect(literals.length).toBeGreaterThan(0);
    expect(literals.filter((value) => !known.has(value))).toEqual([]);
  });

  it('sets the page chrome of each theme to the palette values (no flash of the wrong colours)', () => {
    const block = (selector: string): string => {
      const start = css.indexOf(selector);
      expect(start).toBeGreaterThanOrEqual(0);
      return css.slice(start, css.indexOf('}', start));
    };
    const expectChrome = (text: string, theme: 'light' | 'dark'): void => {
      const palette = palettes[theme];
      expect(text).toContain(`--cg-canvas: ${palette.surfaces.canvas.toLowerCase()}`);
      expect(text).toContain(`--cg-surface: ${palette.surfaces.surface.toLowerCase()}`);
      expect(text).toContain(`--cg-text: ${palette.text.primary.toLowerCase()}`);
      expect(text).toContain(`--cg-focus: ${palette.borders.focus.toLowerCase()}`);
    };
    expectChrome(block('--cg-canvas: #'), 'light');
    expectChrome(block(":root[data-cg-theme='dark']"), 'dark');
  });
});

/** A fixed length (`4px`, `0.5rem`) written in a style value. Relative units (`em`, `%`) are layout, not spacing. */
const LENGTH = /-?(?:\d+\.?\d*|\.\d+)(?:px|rem)\b/g;
const SPACING = /^(?:gap|rowGap|columnGap|padding\w*|margin\w*)$/;
const RADIUS = /^borderRadius$/;

/** Every `gap`, `padding*`, `margin*` and `borderRadius` in the style objects of a source file that holds a fixed length. */
function fixedLengths(file: string): string[] {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
    ) {
      const name = node.name.text;
      const radius = RADIUS.test(name);
      if (radius || SPACING.test(name)) {
        const initializer = node.initializer;
        const lengths: string[] = [];
        const collect = (inner: ts.Node): void => {
          if (ts.isStringLiteralLike(inner)) lengths.push(...(inner.text.match(LENGTH) ?? []));
          else if (
            ts.isTemplateHead(inner) ||
            ts.isTemplateMiddle(inner) ||
            ts.isTemplateTail(inner)
          )
            lengths.push(...(inner.text.match(LENGTH) ?? []));
          else if (
            ts.isNumericLiteral(inner) &&
            Number(inner.text) !== 0 &&
            ts.isPropertyAssignment(inner.parent)
          )
            lengths.push(inner.text);
          ts.forEachChild(inner, collect);
        };
        collect(initializer);
        // A one-pixel overlap or offset (a hairline) is not a spacing decision; a corner radius never is one.
        const real = lengths.filter(
          (length) =>
            radius || !/^-?(?:0|1)(?:\.0+)?px$/.test(length) || !name.startsWith('margin'),
        );
        if (real.length > 0) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart());
          found.push(`${file}:${line + 1} ${node.getText()}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('[UI-TOKENS-03] spacing and corner radii come from the scales', () => {
  // The investigation graph is positioned in SVG user units, which are not CSS lengths.
  const SVG_UNITS = new Set(['packages/ui/src/graph/layout.ts']);

  it('has no fixed gap, padding, margin or corner radius in any component or page', () => {
    const files = [
      ...sources(join(ROOT, 'apps/web/src')),
      ...sources(join(ROOT, 'packages/ui/src')),
    ]
      .map((path) => relative(ROOT, path))
      .filter((file) => !SVG_UNITS.has(file));
    expect(files.flatMap(fixedLengths)).toEqual([]);
  });
});
