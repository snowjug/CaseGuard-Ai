'use client';

import { palettes, radius, space, type Palette } from '@caseguard/ui/server';
import { useEffect, useRef } from 'react';

const variables = (palette: Palette): string =>
  [
    `--bg:${palette.surfaces.canvas}`,
    `--card:${palette.surfaces.surface}`,
    `--text:${palette.text.primary}`,
    `--muted:${palette.text.secondary}`,
    `--border:${palette.borders.subtle}`,
    `--control:${palette.borders.control}`,
    `--focus:${palette.borders.focus}`,
    `--brand:${palette.tones.brand.solid}`,
    `--on-brand:${palette.tones.brand.onSolid}`,
  ].join(';');

// The page replaces the root layout, so the theme provider and the global stylesheet do not exist: the same palette is
// written out as plain CSS, in both themes, following the system setting.
const CSS = `
:root{color-scheme:light dark;${variables(palettes.light)}}
@media (prefers-color-scheme:dark){:root{${variables(palettes.dark)}}}
body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:${space[6]}px;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
main{max-width:560px;width:100%;box-sizing:border-box;padding:${space[8]}px;border:1px solid var(--border);border-radius:${radius.xl}px;background:var(--card)}
h1{margin:0 0 ${space[2]}px;font-size:24px;line-height:1.25;letter-spacing:-0.02em}
p{margin:0 0 ${space[4]}px;color:var(--muted)}
code{font-family:ui-monospace,'SFMono-Regular',Menlo,Consolas,monospace;font-size:13px;color:var(--text)}
.actions{display:flex;gap:${space[3]}px;flex-wrap:wrap}
button,a{min-height:44px;box-sizing:border-box;padding:0 ${space[4]}px;border-radius:${radius.md}px;font:inherit;font-weight:600;display:inline-flex;align-items:center;cursor:pointer;text-decoration:none}
button{border:1px solid var(--brand);background:var(--brand);color:var(--on-brand)}
a{border:1px solid var(--control);color:var(--text)}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
`;

/**
 * Last-resort error page. It replaces the root layout, so none of the providers exist here: plain HTML and CSS only,
 * with no dependency on the theme, the API client or the design system components.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <html lang="en">
      <head>
        <title>CaseGuard AI: something went wrong</title>
        <style>{CSS}</style>
      </head>
      <body>
        <main role="alert">
          <h1 ref={heading} tabIndex={-1} style={{ outline: 'none' }}>
            CaseGuard AI hit an unexpected problem
          </h1>
          <p>
            The app could not be displayed. Nothing was changed. Try again; if it keeps happening,
            share this reference with your administrator
            {error.digest ? (
              <>
                : <code>{error.digest}</code>
              </>
            ) : (
              '.'
            )}
          </p>
          <div className="actions">
            <button type="button" onClick={reset}>
              Try again
            </button>
            <a href="/">Go home</a>
          </div>
        </main>
      </body>
    </html>
  );
}
