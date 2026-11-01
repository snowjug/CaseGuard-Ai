import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { caseSummary, session } from '../../../test/fixtures';
import { expectNoAxeViolations, fakeApi, renderApp } from '../../../test/harness';
import { navigateTo, router } from '../../../test/next-navigation';
import { expectToast } from '../../../test/u4-support';
import { SINGLE_KEY_STORAGE_KEY } from '../../lib/shortcuts';
import { AppShell } from './AppShell';

const api = () =>
  fakeApi({
    'session.me': () => session('reviewer', ['case:read', 'quality:read']),
    'cases.list': () => ({ items: [caseSummary()], nextCursor: null }),
    'demo.state': () => ({
      steps: [],
      seededAt: null,
      datasetLabel: '',
      provider: 'deterministic',
      providerSimulated: true,
      caseOneId: null,
      caseTwoId: null,
      skillId: null,
      notices: [],
    }),
    'search.global': () => ({ items: [], query: 'x' }),
  });

function mount(mode: 'light' | 'dark' = 'light') {
  navigateTo('/');
  return renderApp(
    <AppShell>
      <h1>Page title</h1>
    </AppShell>,
    { api: api(), mode },
  );
}

const searchBox = () => screen.getByRole('combobox', { name: /Search cases/ });

// Only the palette's own options. The header's native case <select> has <option>s too, and whether
// they are still exposed while the modal palette opens is a matter of timing, so a document-wide
// query for options is fragile.
const paletteOptions = () =>
  within(screen.getByRole('listbox', { name: 'Commands' })).getAllByRole('option');

async function openHelpFromTheFooter(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));
  return screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
}

describe('[UX-KEYS-04] single-key shortcuts can be turned off (WCAG 2.1.4)', () => {
  it('has the setting in the shortcut help, on by default, and explains what turning it off does', async () => {
    const user = userEvent.setup();
    mount();
    await user.keyboard('?');
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    const toggle = within(dialog).getByRole('switch', { name: 'Single-key shortcuts' });
    expect(toggle).toBeChecked();
    expect(toggle).toHaveAccessibleDescription(/Shortcuts made of one key, such as \/ or G then C/);
    expect(window.localStorage.getItem(SINGLE_KEY_STORAGE_KEY)).toBeNull();

    await user.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(window.localStorage.getItem(SINGLE_KEY_STORAGE_KEY)).toBe('off');
    await expectToast('Single-key shortcuts are off');
    expect(toggle).toHaveAccessibleDescription(/Single-key shortcuts are off now/);
    // Only what still works is listed.
    expect(within(dialog).getByText('Open the command palette')).toBeInTheDocument();
    expect(within(dialog).getByText('Ctrl+K')).toBeInTheDocument();
    expect(within(dialog).queryByText('Go to Cases')).toBeNull();
    expect(within(dialog).queryByText('G then C')).toBeNull();
    expect(within(dialog).queryByText('Show keyboard shortcuts')).toBeNull();
  });

  it('stops / and g c, keeps Ctrl+K, and starts them again when it is turned back on', async () => {
    const user = userEvent.setup();
    mount();
    await user.keyboard('gc');
    expect(router.push).toHaveBeenCalledTimes(1);
    router.push.mockClear();

    await user.keyboard('?');
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    await user.click(within(dialog).getByRole('switch', { name: 'Single-key shortcuts' }));
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull(),
    );

    await user.keyboard('gc');
    expect(router.push).not.toHaveBeenCalled();
    await user.keyboard('/');
    expect(searchBox()).not.toHaveFocus();
    await user.keyboard('?');
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
    // A shortcut with a modifier is not a character key shortcut: it keeps working.
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull(),
    );

    // Back on, from the help opened with the footer button (the ? key is off too).
    const help = await openHelpFromTheFooter(user);
    await user.click(within(help).getByRole('switch', { name: 'Single-key shortcuts' }));
    await expectToast('Single-key shortcuts are on');
    expect(window.localStorage.getItem(SINGLE_KEY_STORAGE_KEY)).toBe('on');
    await user.click(within(help).getByRole('button', { name: 'Close' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull(),
    );
    await user.keyboard('gc');
    expect(router.push).toHaveBeenCalledWith('/cases');
    await user.keyboard('/');
    expect(searchBox()).toHaveFocus();
  });

  it('is remembered: a page that starts with it off has no single-key shortcuts', async () => {
    window.localStorage.setItem(SINGLE_KEY_STORAGE_KEY, 'off');
    const user = userEvent.setup();
    mount();
    await user.keyboard('gc');
    await user.keyboard('/');
    await user.keyboard('?');
    expect(router.push).not.toHaveBeenCalled();
    expect(searchBox()).not.toHaveFocus();
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
    const help = await openHelpFromTheFooter(user);
    expect(within(help).getByRole('switch', { name: 'Single-key shortcuts' })).not.toBeChecked();
  });

  it('is a command in the palette that says what it will do, and announces the change', async () => {
    const user = userEvent.setup();
    mount();
    await user.keyboard('{Control>}k{/Control}');
    let input = await screen.findByRole('combobox', { name: 'Search commands' });
    expect(screen.getByRole('option', { name: /Go to Cases\s*G then C/ })).toBeInTheDocument();
    await user.type(input, 'single-key');
    expect(paletteOptions()[0]).toHaveAccessibleName(/^Turn single-key shortcuts off/);
    await user.keyboard('{Enter}');
    await expectToast('Single-key shortcuts are off');
    expect(window.localStorage.getItem(SINGLE_KEY_STORAGE_KEY)).toBe('off');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull(),
    );

    await user.keyboard('{Control>}k{/Control}');
    input = await screen.findByRole('combobox', { name: 'Search commands' });
    // The hints of the shortcuts that no longer work are gone.
    expect(screen.getByRole('option', { name: 'Go to Cases' })).toBeInTheDocument();
    await user.type(input, 'single-key');
    expect(paletteOptions()[0]).toHaveAccessibleName(/^Turn single-key shortcuts on/);
    await user.keyboard('{Enter}');
    await expectToast('Single-key shortcuts are on');
    expect(window.localStorage.getItem(SINGLE_KEY_STORAGE_KEY)).toBe('on');
  });

  it('follows a change made in another tab, including the "/" hint of the search box', async () => {
    const user = userEvent.setup();
    const { container } = mount();
    expect(within(container).getByText('/', { selector: 'kbd' })).toBeInTheDocument();
    act(() => {
      window.localStorage.setItem(SINGLE_KEY_STORAGE_KEY, 'off');
      window.dispatchEvent(new StorageEvent('storage', { key: SINGLE_KEY_STORAGE_KEY }));
    });
    await waitFor(() => expect(within(container).queryByText('/', { selector: 'kbd' })).toBeNull());
    await user.keyboard('gc');
    expect(router.push).not.toHaveBeenCalled();
  });

  for (const mode of ['light', 'dark'] as const) {
    it(`has no accessibility violations in the shortcut help, on and off (${mode})`, async () => {
      const user = userEvent.setup();
      mount(mode);
      await user.keyboard('?');
      const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
      await expectNoAxeViolations(document.body);
      await user.click(within(dialog).getByRole('switch', { name: 'Single-key shortcuts' }));
      await expectNoAxeViolations(document.body);
    });
  }
});
