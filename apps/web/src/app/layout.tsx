import '@caseguard/ui/styles.css';
import { THEME_COOKIE, parseThemeMode, themeColorFor } from '@caseguard/ui/server';
import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { CASE_COOKIE, parseCaseId } from '../lib/case-cookie';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: { default: 'CaseGuard AI', template: '%s · CaseGuard AI' },
  description:
    'Evidence-first analysis of support investigations: what was known, what was tried, and what could have been faster. Synthetic demo data.',
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
 * Root layout (Server Component). It reads the `cg-theme` and `cg-case` cookies so the first paint already has the
 * right theme and remembered case. Reading cookies makes every route dynamic, which the per-request CSP nonce needs anyway.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();
  const themeMode = parseThemeMode(jar.get(THEME_COOKIE)?.value);
  const initialCaseId = parseCaseId(jar.get(CASE_COOKIE)?.value);
  return (
    <html lang="en" data-cg-theme={themeMode} suppressHydrationWarning>
      <body>
        <Providers initialThemeMode={themeMode} initialCaseId={initialCaseId}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
