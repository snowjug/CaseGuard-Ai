'use client';

import {
  CaseGuardThemeProvider,
  UiLinkProvider,
  createCaseGuardRenderer,
  createStyleFlusher,
  type ThemeMode,
} from '@caseguard/ui';
import { useServerInsertedHTML } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';
import { ActiveCaseProvider } from '../lib/active-case';
import { ApiClientProvider, QueryProvider } from '../lib/api/provider';
import { AuthProviderRoot } from '../lib/auth/auth-provider';
import { NextLinkAdapter } from '../lib/link';
import { PresentationProvider, usePresentation } from '../lib/presentation';
import { KeyboardShortcutsProvider } from '../lib/shortcuts';
import { ToastProvider } from '../lib/toast';

function Themed({
  initialThemeMode,
  children,
}: {
  initialThemeMode: ThemeMode;
  children: ReactNode;
}) {
  const { enabled } = usePresentation();
  // The same Griffel renderer serves the provider and the server style flush, so server-rendered rules reach the HTML.
  const [renderer] = useState(() => createCaseGuardRenderer());
  const flush = useMemo(() => createStyleFlusher(renderer), [renderer]);
  useServerInsertedHTML(flush);
  return (
    <CaseGuardThemeProvider
      initialMode={initialThemeMode}
      presentation={enabled}
      renderer={renderer}
    >
      {children}
    </CaseGuardThemeProvider>
  );
}

export interface ProvidersProps {
  /** Theme preference read from the `cg-theme` cookie on the server (no flash on first paint). */
  initialThemeMode: ThemeMode;
  /** Last case remembered in the `cg-case` cookie. */
  initialCaseId: string | null;
  /** The development persona remembered in the `cg-persona` cookie (the page renders signed in from the first byte). */
  initialPersonaId?: string | null;
  children: ReactNode;
}

/**
 * Every app-wide provider, in dependency order: presentation mode, theme (Fluent + SSR style flush), link adapter,
 * TanStack Query, identity (development persona or Entra), typed API client, toasts, keyboard shortcuts, active case.
 */
export function Providers({
  initialThemeMode,
  initialCaseId,
  initialPersonaId = null,
  children,
}: ProvidersProps) {
  return (
    <PresentationProvider>
      <Themed initialThemeMode={initialThemeMode}>
        <UiLinkProvider component={NextLinkAdapter}>
          <QueryProvider>
            <AuthProviderRoot initialPersonaId={initialPersonaId}>
              <ApiClientProvider>
                <ToastProvider>
                  <KeyboardShortcutsProvider>
                    <ActiveCaseProvider initialCaseId={initialCaseId}>
                      {children}
                    </ActiveCaseProvider>
                  </KeyboardShortcutsProvider>
                </ToastProvider>
              </ApiClientProvider>
            </AuthProviderRoot>
          </QueryProvider>
        </UiLinkProvider>
      </Themed>
    </PresentationProvider>
  );
}
