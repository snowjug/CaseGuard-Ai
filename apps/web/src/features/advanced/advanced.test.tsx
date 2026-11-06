import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { caseSummary, session } from '../../../test/fixtures';
import { expectNoAxeViolations, fakeApi, renderApp } from '../../../test/harness';
import { demoState, systemHealth } from '../../../test/u4-fixtures';
import { ShellUiProvider } from '../../lib/shell-ui';
import { ShortcutsDialog } from '../../components/shell/ShortcutsDialog';
import { AdvancedPage } from './AdvancedPage';

function mount() {
  return renderApp(
    <ShellUiProvider>
      <AdvancedPage />
      <ShortcutsDialog />
    </ShellUiProvider>,
    {
      api: fakeApi({
        'session.me': () => session('administrator', ['case:read', 'telemetry:read']),
        'cases.list': () => ({ items: [caseSummary()], nextCursor: null }),
        'demo.state': () => demoState(4),
        'system.health': () => systemHealth({ status: 'degraded' }),
      }),
    },
  );
}

describe('[UX-ADV-01] the Advanced page', () => {
  it('links to the four admin and developer views, with the demo progress and system status on their cards', async () => {
    mount();
    expect(screen.getByRole('heading', { level: 1, name: 'Advanced' })).toBeInTheDocument();
    for (const [name, href] of [
      ['Settings and audit', '/governance'],
      ['Usage and cost', '/efficiency'],
      ['System status', '/system'],
      ['Guided demo', '/demo'],
    ] as const)
      expect(screen.getByRole('link', { name: new RegExp(`^${name}`) })).toHaveAttribute(
        'href',
        href,
      );
    expect(
      await screen.findByRole('link', { name: /^Guided demo.*4 of 13 demo steps complete/ }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('link', { name: /^System status.*Degraded/ }),
    ).toBeInTheDocument();
  });

  it('keeps the preferences here: theme, reduced motion, single-key shortcuts, shortcut help and presentation mode', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('radio', { name: 'Dark' }));
    await waitFor(() => expect(document.cookie).toContain('cg-theme=dark'));

    const motion = screen.getByRole('switch', { name: 'Reduce motion' });
    expect(motion).not.toBeChecked();
    await user.click(motion);
    expect(motion).toBeChecked();
    expect(document.documentElement.dataset.cgReducedMotion).toBe('true');

    const keys = screen.getByRole('switch', { name: 'Single-key shortcuts' });
    expect(keys).toBeChecked();
    await user.click(keys);
    expect(keys).not.toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Show keyboard shortcuts' }));
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Turn on presentation mode' }));
    expect(
      await screen.findByRole('button', { name: 'Turn off presentation mode' }),
    ).toBeInTheDocument();
    expect(window.sessionStorage.getItem('cg-present')).toBe('1');
  });

  it('has no accessibility violations', async () => {
    const { container } = mount();
    await screen.findByRole('link', { name: /^Guided demo.*4 of 13/ });
    await expectNoAxeViolations(container);
    expect(within(container).getAllByRole('heading', { level: 2 }).length).toBeGreaterThanOrEqual(
      5,
    );
  });
});
