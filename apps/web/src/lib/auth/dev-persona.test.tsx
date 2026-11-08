import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations, fakeApi, renderApp } from '../../../test/harness';
import { persona } from '../../../test/fixtures';
import { ApiError } from '../api/errors';
import { useAuth, type AuthContextValue } from './context';
import {
  DevIdentityBadge,
  DevPersonaAuthProvider,
  PersonaPickerDialog,
  createPersonaStore,
  parsePersonaId,
} from './dev-persona';

describe('[SEC-DEV-01] persona ids from storage are validated', () => {
  it('accepts well-formed ids only', () => {
    expect(parsePersonaId('persona_engineer')).toBe('persona_engineer');
    expect(parsePersonaId('persona.reviewer-2:x')).toBe('persona.reviewer-2:x');
    expect(parsePersonaId('bad id')).toBeNull();
    expect(parsePersonaId('<script>')).toBeNull();
    expect(parsePersonaId('')).toBeNull();
    expect(parsePersonaId(null)).toBeNull();
    expect(parsePersonaId('x'.repeat(130))).toBeNull();
  });

  it('ignores a tampered localStorage value', () => {
    window.localStorage.setItem('cg-persona', '../../admin');
    expect(createPersonaStore().get()).toBeNull();
  });
});

function Capture({ onAuth }: { onAuth: (auth: AuthContextValue) => void }) {
  const auth = useAuth();
  useEffect(() => {
    onAuth(auth);
  });
  return (
    <p>
      status:{auth.status} key:{auth.identityKey}
    </p>
  );
}

describe('[AUTH-DEV-01] DevPersonaAuth', () => {
  it('is signed out until a persona is chosen, and sends no identity header', async () => {
    let auth: AuthContextValue | null = null;
    render(
      <DevPersonaAuthProvider>
        <Capture onAuth={(value) => (auth = value)} />
      </DevPersonaAuthProvider>,
    );
    expect(screen.getByText(/status:unauthenticated/)).toBeInTheDocument();
    expect(await (auth as AuthContextValue | null)?.getAuthHeaders()).toEqual({});
  });

  it('sends x-cg-persona once chosen and remembers the choice in localStorage and a Strict cookie', async () => {
    let auth: AuthContextValue | null = null;
    render(
      <DevPersonaAuthProvider>
        <Capture onAuth={(value) => (auth = value)} />
      </DevPersonaAuthProvider>,
    );
    act(() => auth?.dev?.selectPersona('persona_reviewer'));
    expect(screen.getByText(/status:ready key:dev:persona_reviewer/)).toBeInTheDocument();
    expect(await (auth as AuthContextValue | null)?.getAuthHeaders()).toEqual({
      'x-cg-persona': 'persona_reviewer',
    });
    expect(window.localStorage.getItem('cg-persona')).toBe('persona_reviewer');
    expect(document.cookie).toContain('cg-persona=persona_reviewer');
  });

  it('restores the stored persona on load and clears everything on sign out', async () => {
    window.localStorage.setItem('cg-persona', 'persona_manager');
    let auth: AuthContextValue | null = null;
    render(
      <DevPersonaAuthProvider>
        <Capture onAuth={(value) => (auth = value)} />
      </DevPersonaAuthProvider>,
    );
    expect(screen.getByText(/status:ready key:dev:persona_manager/)).toBeInTheDocument();
    await act(async () => auth?.signOut());
    expect(screen.getByText(/status:unauthenticated/)).toBeInTheDocument();
    expect(window.localStorage.getItem('cg-persona')).toBeNull();
  });

  it('renders a returning person as loading on the server (not as the first-visit page), and signed out without a cookie', () => {
    const page = (initialPersonaId?: string | null) =>
      renderToString(
        <DevPersonaAuthProvider
          {...(initialPersonaId === undefined ? {} : { initialPersonaId })}
          store={createPersonaStore(() => undefined)}
        >
          <Capture onAuth={() => undefined} />
        </DevPersonaAuthProvider>,
      );
    expect(page('persona_manager')).toContain('status:<!-- -->loading');
    expect(page('persona_manager')).toContain('key:<!-- -->dev:none');
    expect(page(null)).toContain('status:<!-- -->unauthenticated');
    expect(page()).toContain('status:<!-- -->unauthenticated');
  });

  it('gives each persona its own cache partition key (no data leaks between roles)', () => {
    const keys: string[] = [];
    let auth: AuthContextValue | null = null;
    render(
      <DevPersonaAuthProvider>
        <Capture
          onAuth={(value) => {
            auth = value;
            keys.push(value.identityKey);
          }}
        />
      </DevPersonaAuthProvider>,
    );
    act(() => auth?.dev?.selectPersona('persona_a'));
    act(() => auth?.dev?.selectPersona('persona_b'));
    expect([...new Set(keys)]).toEqual(['dev:none', 'dev:persona_a', 'dev:persona_b']);
  });
});

const personas = [
  persona('persona_engineer', 'engineer', 'Eli Engineer'),
  persona('persona_reviewer', 'reviewer', 'Rae Reviewer'),
];

function Opener() {
  const auth = useAuth();
  return (
    <button type="button" onClick={() => auth.dev?.openPicker()}>
      Open picker
    </button>
  );
}

describe('[AUTH-DEV-02] persona picker dialog', () => {
  it('lists the seeded personas with a visible development-identity warning, and switches on click', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      'dev.personas': () => ({ enabled: true, notice: 'Synthetic personas only', items: personas }),
    });
    renderApp(
      <>
        <Opener />
        <PersonaPickerDialog />
      </>,
      { api, persona: null },
    );
    await user.click(screen.getByRole('button', { name: 'Open picker' }));
    const dialog = await screen.findByRole('dialog', { name: 'Choose a development identity' });
    expect(within(dialog).getByText(/not real sign-in/)).toBeInTheDocument();
    const list = await within(dialog).findByRole('list', { name: 'Personas' });
    expect(within(list).getAllByRole('button')).toHaveLength(2);
    await expectNoAxeViolations(dialog);
    await user.click(within(list).getByRole('button', { name: /Rae Reviewer/ }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(window.localStorage.getItem('cg-persona')).toBe('persona_reviewer');
  });

  it('gives focus back to the control that opened it when it is closed with Escape, so a keyboard user keeps their place', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      'dev.personas': () => ({ enabled: true, notice: '', items: personas }),
    });
    renderApp(
      <>
        <Opener />
        <PersonaPickerDialog />
      </>,
      { api, persona: null },
    );
    const opener = screen.getByRole('button', { name: 'Open picker' });
    await user.click(opener);
    await screen.findByRole('dialog', { name: 'Choose a development identity' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('marks the chosen persona, and only that one (its tinted state is covered by the contrast guard)', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      'dev.personas': () => ({ enabled: true, notice: '', items: personas }),
    });
    renderApp(
      <>
        <Opener />
        <PersonaPickerDialog />
      </>,
      { api, persona: 'persona_reviewer' },
    );
    await user.click(screen.getByRole('button', { name: 'Open picker' }));
    const list = await screen.findByRole('list', { name: 'Personas' });
    expect(within(list).getByRole('button', { name: /Rae Reviewer/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(list).getByRole('button', { name: /Eli Engineer/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('explains when development identity is disabled', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      'dev.personas': () => ({
        enabled: false,
        notice: 'Development identity is disabled in production.',
        items: [],
      }),
    });
    renderApp(
      <>
        <Opener />
        <PersonaPickerDialog />
      </>,
      { api, persona: null },
    );
    await user.click(screen.getByRole('button', { name: 'Open picker' }));
    expect(await screen.findByText('Development identity is disabled')).toBeInTheDocument();
    expect(screen.getByText(/disabled in production/)).toBeInTheDocument();
  });

  it('shows an error with Retry when the persona list cannot be loaded', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const api = fakeApi({
      'dev.personas': () => {
        attempts += 1;
        if (attempts === 1)
          throw new ApiError({ status: 0, code: 'network_error', title: 'Network error' });
        return { enabled: true, notice: '', items: personas };
      },
    });
    renderApp(
      <>
        <Opener />
        <PersonaPickerDialog />
      </>,
      { api, persona: null },
    );
    await user.click(screen.getByRole('button', { name: 'Open picker' }));
    expect(await screen.findByText('Personas could not be loaded')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    expect(await screen.findByRole('list', { name: 'Personas' })).toBeInTheDocument();
  });

  it('badges the development identity so it cannot be mistaken for real sign-in', () => {
    const { container } = render(<DevIdentityBadge />);
    expect(screen.getByText('Development identity')).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute(
      'title',
      expect.stringContaining('not real authentication'),
    );
    vi.restoreAllMocks();
  });
});
