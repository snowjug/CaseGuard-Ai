import axe from 'axe-core';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { expect } from 'vitest';
import { CaseGuardThemeProvider } from '../src/theme/ThemeProvider';
import type { ThemeMode } from '../src/theme/theme-mode';

/** Renders inside the real CaseGuard theme provider, as the app does. */
export function renderWithTheme(ui: ReactElement, mode: ThemeMode = 'light'): RenderResult {
  return render(<CaseGuardThemeProvider initialMode={mode}>{ui}</CaseGuardThemeProvider>);
}

/**
 * Runs axe-core and fails with a readable list of violations. jsdom has no layout engine, so colour contrast is
 * verified separately by the token contrast tests; page-level landmark rules do not apply to a fragment.
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
