'use client';

import { useEffect, useRef } from 'react';

const CSS = `
:root{color-scheme:light dark;--bg:#f5f6fb;--card:#ffffff;--text:#12172b;--muted:#4a5270;--border:#c9cee3;--brand:#4b55c9;--on-brand:#ffffff}
@media (prefers-color-scheme:dark){:root{--bg:#0b1020;--card:#111830;--text:#eef1fb;--muted:#b7bfdc;--border:#3a4366;--brand:#aeb6ff;--on-brand:#0b1020}}
body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--text);font:14px/1.5 'Segoe UI Variable Text','Segoe UI',system-ui,sans-serif}
main{max-width:560px;width:100%;padding:32px;border:1px solid var(--border);border-radius:12px;background:var(--card)}
h1{margin:0 0 8px;font-size:22px}
p{margin:0 0 16px;color:var(--muted)}
code{font-family:Consolas,monospace;font-size:12px}
.actions{display:flex;gap:12px;flex-wrap:wrap}
button,a{min-height:36px;padding:0 16px;border-radius:8px;font:inherit;font-weight:600;display:inline-flex;align-items:center;cursor:pointer;text-decoration:none}
button{border:1px solid var(--brand);background:var(--brand);color:var(--on-brand)}
a{border:1px solid var(--border);color:var(--text)}
:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
`;

/**
 * Last-resort error page. It replaces the root layout, so none of the providers exist here: plain HTML and CSS only,
 * with no dependency on the theme, the API client or the design system.
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
            The application could not be displayed. Nothing was changed. Try again; if it keeps
            happening, share this reference with your administrator
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
            <a href="/">Reload the Command Center</a>
          </div>
        </main>
      </body>
    </html>
  );
}
