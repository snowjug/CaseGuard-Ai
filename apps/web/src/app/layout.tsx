import '@caseguard/ui/styles.css';
import { THEME_COOKIE, parseThemeMode, themeColorFor } from '@caseguard/ui/server';
import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { CASE_COOKIE, parseCaseId } from '../lib/case-cookie';
import { PERSONA_COOKIE, personaIdFromCookie } from '../lib/auth/persona-id';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: { default: 'CaseGuard AI', template: '%s · CaseGuard AI' },
  description:
    'Review support cases in minutes: see how a case went, what to fix first, and what would have changed the outcome. Demo data only.',
  applicationName: 'CaseGuard AI',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: themeColorFor('light') },
    { media: '(prefers-color-scheme: dark)', color: themeColorFor('dark') },
  ],
};

/**
 * Root layout (Server Component). It reads the `cg-theme`, `cg-case` and `cg-persona` cookies so the first paint already
 * has the right theme and remembered case, and shows a returning person's skeleton instead of the first-visit page.
 * Reading cookies makes every route dynamic, which the per-request CSP nonce needs anyway.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();
  const themeMode = parseThemeMode(jar.get(THEME_COOKIE)?.value);
  const initialCaseId = parseCaseId(jar.get(CASE_COOKIE)?.value);
  const initialPersonaId = personaIdFromCookie(jar.get(PERSONA_COOKIE)?.value);
  return (
    <html lang="en" data-cg-theme={themeMode} suppressHydrationWarning>
      <body>
        <Providers
          initialThemeMode={themeMode}
          initialCaseId={initialCaseId}
          initialPersonaId={initialPersonaId}
        >
          {children}
        </Providers>
      </body>
    </html>
  );
}
