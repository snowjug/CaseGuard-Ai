import {
  InteractionRequiredAuthError,
  type AccountInfo,
  type IPublicClientApplication,
} from '@azure/msal-browser';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AuthRequiredError, useAuth, type AuthContextValue } from './context';
import {
  EntraAuthProvider,
  createEntraConfiguration,
  readEntraSettings,
  type EntraSettings,
} from './entra';

/*
 * These tests drive the Entra strategy with a MOCKED MSAL instance. They prove the wiring (scopes, headers, redirects,
 * cache partition) and not the behaviour of a real tenant: the Entra path has not been validated against live Entra ID.
 */

const settings: EntraSettings = {
  clientId: 'client-id',
  authority: 'https://login.example.test/tenant',
  apiScope: 'api://caseguard/access_as_user',
};

const account = {
  homeAccountId: 'home-1',
  environment: 'login.example.test',
  tenantId: 'tenant',
  username: 'ada@example.invalid',
  localAccountId: 'local-1',
  name: 'Ada Example',
} as AccountInfo;

function mockMsal(accounts: AccountInfo[], options: { activeAccount?: AccountInfo | null } = {}) {
  let active: AccountInfo | null = options.activeAccount ?? null;
  const logger = {
    clone: () => logger,
    info: vi.fn(),
    verbose: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    isPiiLoggingEnabled: () => false,
  };
  const instance = {
    initializeWrapperLibrary: vi.fn(),
    getLogger: () => logger,
    addEventCallback: vi.fn(() => 'callback-1'),
    removeEventCallback: vi.fn(),
    initialize: vi.fn(async () => undefined),
    handleRedirectPromise: vi.fn(async () => null),
    getAllAccounts: vi.fn(() => accounts),
    getActiveAccount: vi.fn(() => active),
    setActiveAccount: vi.fn((next: AccountInfo | null) => {
      active = next;
    }),
    acquireTokenSilent: vi.fn(async () => ({ accessToken: 'test-access-token' })),
    acquireTokenRedirect: vi.fn(async () => undefined),
    loginRedirect: vi.fn(async () => undefined),
    logoutRedirect: vi.fn(async () => undefined),
  };
  return instance as typeof instance & IPublicClientApplication;
}

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

function mount(instance: IPublicClientApplication) {
  let auth: AuthContextValue | null = null;
  render(
    <EntraAuthProvider instance={instance} settings={settings}>
      <Capture onAuth={(value) => (auth = value)} />
    </EntraAuthProvider>,
  );
  return () => auth as unknown as AuthContextValue;
}

describe('[AUTH-ENTRA-01] configuration', () => {
  it('reports exactly which NEXT_PUBLIC_ENTRA_* settings are missing', () => {
    expect(
      readEntraSettings({ clientId: undefined, authority: undefined, apiScope: undefined }),
    ).toEqual({
      ok: false,
      missing: [
        'NEXT_PUBLIC_ENTRA_CLIENT_ID',
        'NEXT_PUBLIC_ENTRA_AUTHORITY',
        'NEXT_PUBLIC_ENTRA_API_SCOPE',
      ],
    });
    expect(
      readEntraSettings({
        clientId: 'c',
        authority: 'https://login.example.test/t',
        apiScope: 'api://x/y',
      }),
    ).toEqual({
      ok: true,
      settings: { clientId: 'c', authority: 'https://login.example.test/t', apiScope: 'api://x/y' },
    });
  });

  it('uses the redirect flow, the page origin and a session-scoped token cache', () => {
    const configuration = createEntraConfiguration(settings, 'https://app.example.test');
    expect(configuration.auth.redirectUri).toBe('https://app.example.test');
    expect(configuration.auth.postLogoutRedirectUri).toBe('https://app.example.test');
    expect(configuration.cache?.cacheLocation).toBe('sessionStorage');
  });
});

describe('[AUTH-ENTRA-02] EntraAuth with a mocked MSAL instance', () => {
  it('starts in loading, then reports signed out when there is no account', async () => {
    const instance = mockMsal([]);
    mount(instance);
    await waitFor(() => expect(screen.getByText(/status:unauthenticated/)).toBeInTheDocument());
    expect(instance.initialize).toHaveBeenCalled();
    expect(instance.handleRedirectPromise).toHaveBeenCalled();
  });

  it('signs in through a redirect requesting the API scope', async () => {
    const instance = mockMsal([]);
    const auth = mount(instance);
    await waitFor(() => expect(auth()).toBeTruthy());
    await act(async () => auth().signIn?.());
    expect(instance.loginRedirect).toHaveBeenCalledWith({
      scopes: ['api://caseguard/access_as_user'],
    });
  });

  it('is ready with an account, partitions the cache by home account and adopts it as the active account', async () => {
    const instance = mockMsal([account]);
    mount(instance);
    await waitFor(() =>
      expect(screen.getByText(/status:ready key:entra:home-1/)).toBeInTheDocument(),
    );
    await waitFor(() => expect(instance.setActiveAccount).toHaveBeenCalledWith(account));
  });

  it('acquires a token silently for the API scope and sends it as a bearer header', async () => {
    const instance = mockMsal([account], { activeAccount: account });
    const auth = mount(instance);
    await waitFor(() => expect(screen.getByText(/status:ready/)).toBeInTheDocument());
    const headers = await auth().getAuthHeaders();
    expect(instance.acquireTokenSilent).toHaveBeenCalledWith({
      scopes: ['api://caseguard/access_as_user'],
      account,
    });
    expect(headers).toEqual({ authorization: 'Bearer test-access-token' });
  });

  it('sends the person through an interactive redirect when the session needs interaction', async () => {
    const instance = mockMsal([account], { activeAccount: account });
    instance.acquireTokenSilent.mockRejectedValueOnce(
      new InteractionRequiredAuthError('interaction_required', 'expired'),
    );
    const auth = mount(instance);
    await waitFor(() => expect(screen.getByText(/status:ready/)).toBeInTheDocument());
    await expect(auth().getAuthHeaders()).rejects.toBeInstanceOf(AuthRequiredError);
    expect(instance.acquireTokenRedirect).toHaveBeenCalledWith({
      scopes: ['api://caseguard/access_as_user'],
      account,
    });
  });

  it('does not swallow unexpected token errors', async () => {
    const instance = mockMsal([account], { activeAccount: account });
    instance.acquireTokenSilent.mockRejectedValueOnce(new Error('network down'));
    const auth = mount(instance);
    await waitFor(() => expect(screen.getByText(/status:ready/)).toBeInTheDocument());
    await expect(auth().getAuthHeaders()).rejects.toThrow('network down');
    expect(instance.acquireTokenRedirect).not.toHaveBeenCalled();
  });

  it('refuses to produce headers without an account', async () => {
    const instance = mockMsal([]);
    const auth = mount(instance);
    await waitFor(() => expect(screen.getByText(/status:unauthenticated/)).toBeInTheDocument());
    await expect(auth().getAuthHeaders()).rejects.toBeInstanceOf(AuthRequiredError);
    expect(instance.acquireTokenSilent).not.toHaveBeenCalled();
  });

  it('signs out through a redirect for the current account', async () => {
    const instance = mockMsal([account], { activeAccount: account });
    const auth = mount(instance);
    await waitFor(() => expect(screen.getByText(/status:ready/)).toBeInTheDocument());
    await act(async () => auth().signOut());
    expect(instance.logoutRedirect).toHaveBeenCalledWith({ account });
  });
});
