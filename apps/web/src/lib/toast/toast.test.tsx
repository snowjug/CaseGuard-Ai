import axe from 'axe-core';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { session } from '../../../test/fixtures';
import { fakeApi, renderApp } from '../../../test/harness';
import { navigateTo } from '../../../test/next-navigation';
import { demoState } from '../../../test/u4-fixtures';
import { AppShell } from '../../components/shell/AppShell';
import { PRESENTER_HEIGHT_VAR } from '../presentation/presenter-height';
import { useToast } from './index';

function ToastButtons() {
  const toast = useToast();
  return (
    <>
      <button type="button" onClick={() => toast.success('Saved the settings')}>
        Show success
      </button>
      <button type="button" onClick={() => toast.error('Could not save')}>
        Show error
      </button>
    </>
  );
}

const shell = () =>
  fakeApi({
    'session.me': () => session('engineer', ['case:read']),
    'cases.list': () => ({ items: [], nextCursor: null }),
    'demo.state': () => demoState(0),
    'search.global': () => ({ items: [], query: 'x' }),
  });

describe('[UX-TOAST-01] toasts sit inside a landmark', () => {
  it('shows a toast inside a region named Notifications', async () => {
    const user = userEvent.setup();
    renderApp(<ToastButtons />);
    await user.click(screen.getByRole('button', { name: 'Show success' }));
    const region = await screen.findByRole('region', { name: 'Notifications' });
    const toast = await within(region).findByText('Saved the settings');
    expect(toast.closest('[role="listitem"]')).not.toBeNull();
  });

  it('keeps announcing in the polite and assertive live regions', async () => {
    const user = userEvent.setup();
    renderApp(<ToastButtons />);
    await user.click(screen.getByRole('button', { name: 'Show success' }));
    await waitFor(() =>
      expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain(
        'Saved the settings',
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Show error' }));
    await waitFor(() =>
      expect(document.querySelector('[aria-live="assertive"]')?.textContent).toContain(
        'Could not save',
      ),
    );
  });

  it('leaves no page content outside a landmark while a toast is on screen (axe region)', async () => {
    const user = userEvent.setup();
    renderApp(
      <AppShell>
        <h1>Page title</h1>
        <ToastButtons />
      </AppShell>,
      { api: shell() },
    );
    await user.click(screen.getByRole('button', { name: 'Show success' }));
    await screen.findAllByText('Saved the settings');
    const results = await axe.run(
      { include: [document.body], exclude: [['[data-tabster-dummy]']] },
      { runOnly: { type: 'rule', values: ['region'] } },
    );
    const summary = results.violations.flatMap((violation) =>
      violation.nodes.map((node) => `${violation.id}: ${node.html.slice(0, 160)}`),
    );
    expect(summary, summary.join('\n')).toEqual([]);
  });
});

describe('[UX-TOAST-02] toasts stay clear of the presenter strip', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty(PRESENTER_HEIGHT_VAR);
  });

  const slotOf = async (): Promise<HTMLElement> => {
    const region = await screen.findByRole('region', { name: 'Notifications' });
    await within(region).findByText('Saved the settings');
    const slot = region.querySelector<HTMLElement>('[data-toaster-position="bottom-end"]');
    if (!slot) throw new Error('No toast container in the Notifications region');
    return slot;
  };

  it('sits 16 px from the bottom edge when not presenting', async () => {
    const user = userEvent.setup();
    renderApp(<ToastButtons />);
    await user.click(screen.getByRole('button', { name: 'Show success' }));
    expect((await slotOf()).style.bottom).toBe('16px');
  });

  it('lifts above the strip by its published height while presenting', async () => {
    const user = userEvent.setup();
    navigateTo('/?present=1');
    document.documentElement.style.setProperty(PRESENTER_HEIGHT_VAR, '260px');
    renderApp(<ToastButtons />);
    await user.click(screen.getByRole('button', { name: 'Show success' }));
    expect((await slotOf()).style.bottom).toBe('272px');
  });
});
