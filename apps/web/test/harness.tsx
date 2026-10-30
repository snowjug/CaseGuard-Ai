import { CaseGuardThemeProvider, type ThemeMode } from '@caseguard/ui';
import type { RouteId } from '@caseguard/schemas';
import type { QueryClient } from '@tanstack/react-query';
import axe from 'axe-core';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { expect, vi, type Mock } from 'vitest';
import { ActiveCaseProvider } from '../src/lib/active-case';
import type { ApiClient } from '../src/lib/api/client';
import { ApiError } from '../src/lib/api/errors';
import { ApiClientProvider, QueryProvider, createQueryClient } from '../src/lib/api/provider';
import { DevPersonaAuthProvider } from '../src/lib/auth/dev-persona';
import { PresentationProvider } from '../src/lib/presentation';
import { KeyboardShortcutsProvider } from '../src/lib/shortcuts';
import { ToastProvider } from '../src/lib/toast';

export type FakeHandler = (input: unknown) => unknown;
export type FakeHandlers = Partial<Record<RouteId, FakeHandler>>;

export interface FakeApi extends ApiClient {
  call: ApiClient['call'] & Mock;
}

/**
 * A fake API client: each route answers with the value (or error) its handler returns. Routes without a handler fail
 * with a 404 Problem so a test notices an unexpected call instead of silently receiving `undefined`.
 */
export function fakeApi(handlers: FakeHandlers): FakeApi {
  const call = vi.fn(async (routeId: RouteId, input?: unknown) => {
    const handler = handlers[routeId];
    if (!handler)
      throw new ApiError({
        status: 404,
        code: 'not_found',
        title: 'No fake handler',
        message: `No fake handler for ${routeId}`,
      });
    return handler(input);
  });
  return { call } as unknown as FakeApi;
}

export interface HarnessOptions {
  api?: ApiClient;
  /** Persona stored before rendering (the development identity); `null` renders signed out. */
  persona?: string | null;
  mode?: ThemeMode;
  initialCaseId?: string | null;
  queryClient?: QueryClient;
}

/** Renders inside the same providers as the app (theme, query, identity, API client, toasts, shortcuts, active case). */
export function renderApp(
  ui: ReactElement,
  options: HarnessOptions = {},
): RenderResult & { queryClient: QueryClient } {
  const {
    api = fakeApi({}),
    persona = 'persona_engineer',
    mode = 'light',
    initialCaseId = null,
  } = options;
  if (persona !== null) window.localStorage.setItem('cg-persona', persona);
  else window.localStorage.removeItem('cg-persona');
  const queryClient = options.queryClient ?? createQueryClient();
  const result = render(
    <PresentationProvider>
      <CaseGuardThemeProvider initialMode={mode}>
        <QueryProvider client={queryClient}>
          <DevPersonaAuthProvider>
            <ApiClientProvider client={api}>
              <ToastProvider>
                <KeyboardShortcutsProvider>
                  <ActiveCaseProvider initialCaseId={initialCaseId}>{ui}</ActiveCaseProvider>
                </KeyboardShortcutsProvider>
              </ToastProvider>
            </ApiClientProvider>
          </DevPersonaAuthProvider>
        </QueryProvider>
      </CaseGuardThemeProvider>
    </PresentationProvider>,
  );
  return Object.assign(result, { queryClient });
}

/**
 * Runs axe-core and fails with a readable list of violations. jsdom has no layout engine, so colour contrast is
 * verified by the token tests (packages/ui) and by the Playwright scan; page-level landmark rules do not apply to a
 * rendered fragment.
 */
export async function expectNoAxeViolations(container: Element): Promise<void> {
  const results = await axe.run(container, {
    rules: {
      'color-contrast': { enabled: false },
      region: { enabled: false },
      'landmark-one-main': { enabled: false },
      'page-has-heading-one': { enabled: false },
      'scrollable-region-focusable': { enabled: false },
    },
  });
  const summary = results.violations.map(
    (v) =>
      `${v.id} (${v.impact ?? 'n/a'}): ${v.help}\n  ${v.nodes.map((n) => n.html.slice(0, 140)).join('\n  ')}`,
  );
  expect(summary, summary.join('\n')).toEqual([]);
}
