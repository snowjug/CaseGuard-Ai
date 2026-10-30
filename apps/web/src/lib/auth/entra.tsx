'use client';

/**
 * Microsoft Entra ID sign-in with MSAL React.
 *
 * HONESTY NOTE: this path is implemented and unit-tested against a *mocked* MSAL instance only. It has NOT been
 * validated against a live Entra tenant. Treat it as reviewed-but-unproven until it has been exercised with a real app
 * registration (redirect URI, API scope, tenant/role mapping on the API side).
 */
import {
  InteractionRequiredAuthError,
  InteractionStatus,
  PublicClientApplication,
  type Configuration,
  type IPublicClientApplication,
} from '@azure/msal-browser';
import { MsalProvider, useMsal } from '@azure/msal-react';
import { EmptyState } from '@caseguard/ui';
import { useCallback, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { publicEnv, type PublicEnv } from '../env';
import { AuthContext, AuthRequiredError, type AuthContextValue } from './context';

export interface EntraSettings {
  clientId: string;
  authority: string;
  /** Scope that grants access to the CaseGuard API, for example `api://<app-id>/access_as_user`. */
  apiScope: string;
  /** Defaults to the page origin; must match the app registration. */
  redirectUri?: string;
}

/** Validates the NEXT_PUBLIC_ENTRA_* settings; reports exactly which ones are missing. */
export function readEntraSettings(
  env: PublicEnv['entra'],
): { ok: true; settings: EntraSettings } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  if (!env.clientId) missing.push('NEXT_PUBLIC_ENTRA_CLIENT_ID');
  if (!env.authority) missing.push('NEXT_PUBLIC_ENTRA_AUTHORITY');
  if (!env.apiScope) missing.push('NEXT_PUBLIC_ENTRA_API_SCOPE');
  if (missing.length > 0 || !env.clientId || !env.authority || !env.apiScope)
    return { ok: false, missing };
  return {
    ok: true,
    settings: { clientId: env.clientId, authority: env.authority, apiScope: env.apiScope },
  };
}

/** MSAL configuration: redirect flow (no popups), session-scoped token cache. */
export function createEntraConfiguration(settings: EntraSettings, origin: string): Configuration {
  return {
    auth: {
      clientId: settings.clientId,
      authority: settings.authority,
      redirectUri: settings.redirectUri ?? origin,
      postLogoutRedirectUri: settings.redirectUri ?? origin,
    },
    cache: { cacheLocation: 'sessionStorage' },
  };
}

/** Creates the real MSAL client (browser only). Tests pass a mock instead. */
export function createEntraInstance(settings: EntraSettings): IPublicClientApplication {
  return new PublicClientApplication(createEntraConfiguration(settings, window.location.origin));
}

/** Entra identity strategy. `instance` is injected so it can be mocked in tests. */
export function EntraAuthProvider({
  instance,
  settings,
  children,
}: {
  instance: IPublicClientApplication;
  settings: EntraSettings;
  children: ReactNode;
}) {
  return (
    <MsalProvider instance={instance}>
      <EntraBridge settings={settings}>{children}</EntraBridge>
    </MsalProvider>
  );
}

function EntraBridge({ settings, children }: { settings: EntraSettings; children: ReactNode }) {
  const { instance, accounts, inProgress } = useMsal();
  const scopes = useMemo(() => [settings.apiScope], [settings.apiScope]);
  const account = instance.getActiveAccount() ?? accounts[0];
  const homeAccountId = accounts[0]?.homeAccountId;

  useEffect(() => {
    // MSAL needs an active account for silent token requests after a redirect login.
    const first = accounts[0];
    if (first && !instance.getActiveAccount()) instance.setActiveAccount(first);
  }, [instance, accounts]);

  const getAuthHeaders = useCallback(async (): Promise<Record<string, string>> => {
    const current = instance.getActiveAccount() ?? accounts[0];
    if (!current) throw new AuthRequiredError('Sign in with Microsoft Entra ID to continue');
    try {
      const result = await instance.acquireTokenSilent({ scopes, account: current });
      return { authorization: `Bearer ${result.accessToken}` };
    } catch (error) {
      if (error instanceof InteractionRequiredAuthError) {
        // The session expired or consent is needed: send the person through the interactive flow.
        await instance.acquireTokenRedirect({ scopes, account: current });
        throw new AuthRequiredError('Redirecting to sign in');
      }
      throw error;
    }
  }, [instance, accounts, scopes]);

  const value = useMemo<AuthContextValue>(
    () => ({
      mode: 'entra',
      status:
        inProgress === InteractionStatus.Startup
          ? 'loading'
          : account
            ? 'ready'
            : 'unauthenticated',
      identityKey: homeAccountId ? `entra:${homeAccountId}` : 'entra:none',
      getAuthHeaders,
      signIn: () => instance.loginRedirect({ scopes }),
      signOut: () => instance.logoutRedirect(account ? { account } : undefined),
    }),
    [inProgress, account, homeAccountId, getAuthHeaders, instance, scopes],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

const subscribeNever = (): (() => void) => () => undefined;

/** Root of the Entra strategy: validates configuration and creates MSAL only on the client. */
export function EntraRoot({ children }: { children: ReactNode }) {
  // Memoised so the settings object (and therefore the MSAL instance) is created once, not on every render.
  const parsed = useMemo(() => readEntraSettings(publicEnv.entra), []);
  // false while server rendering and hydrating, so the first client render matches the server HTML.
  const onClient = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
  const settings = parsed.ok ? parsed.settings : null;
  const instance = useMemo(
    () => (onClient && settings ? createEntraInstance(settings) : null),
    [onClient, settings],
  );

  const loading = useMemo<AuthContextValue>(
    () => ({
      mode: 'entra',
      status: 'loading',
      identityKey: 'entra:none',
      getAuthHeaders: () => Promise.reject(new AuthRequiredError('Authentication is starting')),
      signOut: () => Promise.resolve(),
    }),
    [],
  );

  if (!parsed.ok) {
    return (
      <EmptyState
        title="Microsoft Entra sign-in is not configured"
        description={`Set ${parsed.missing.join(', ')} for this build, or run with NEXT_PUBLIC_AUTH_MODE=dev for local development.`}
      />
    );
  }
  if (!instance || !settings)
    return <AuthContext.Provider value={loading}>{children}</AuthContext.Provider>;
  return (
    <EntraAuthProvider instance={instance} settings={settings}>
      {children}
    </EntraAuthProvider>
  );
}
