'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { publicEnv } from '../env';
import { useAuth } from '../auth/context';
import { createApiClient, type ApiClient } from './client';

/** Defaults: no automatic retries here (the client retries idempotent calls itself) and no refetch on window focus. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: 15_000, gcTime: 5 * 60_000 },
      mutations: { retry: false },
    },
  });
}

/** TanStack Query provider with a per-app client. */
export function QueryProvider({ children, client }: { children: ReactNode; client?: QueryClient }) {
  const [own] = useState(() => client ?? createQueryClient());
  return <QueryClientProvider client={client ?? own}>{children}</QueryClientProvider>;
}

const ApiClientContext = createContext<ApiClient | null>(null);

/** Builds the API client that signs every request with the active identity. */
export function ApiClientProvider({
  children,
  client,
}: {
  children: ReactNode;
  client?: ApiClient;
}) {
  const auth = useAuth();
  const built = useMemo(
    () =>
      client ??
      createApiClient({
        getAuthHeaders: auth.getAuthHeaders,
        validation: publicEnv.validateResponses,
      }),
    [client, auth.getAuthHeaders],
  );
  return <ApiClientContext.Provider value={built}>{children}</ApiClientContext.Provider>;
}

/** The identity-aware API client. Prefer the typed hooks (`useApiQuery`, `useApiMutation`). */
export function useApiClient(): ApiClient {
  const client = useContext(ApiClientContext);
  if (!client) throw new Error('useApiClient must be used inside <ApiClientProvider>');
  return client;
}
