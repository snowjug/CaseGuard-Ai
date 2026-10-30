'use client';

import type { Persona, Role } from '@caseguard/schemas';
import { useCallback, useMemo } from 'react';
import { useApiQuery } from '../api/hooks';
import { useAuth } from '../auth/context';
import { useSession } from '../auth/session';
import { useToast } from '../toast';

export interface RoleSwitch {
  /** True when a development identity is in use and at least one persona of this tenant can be chosen. */
  available: boolean;
  /** Whether the signed-in identity already holds `role`. */
  actingAs: (role: Role) => boolean;
  /** The persona of this tenant that holds `role`, if any. */
  personaFor: (role: Role) => Persona | null;
  switchTo: (persona: Persona) => void;
}

/**
 * Switching the development persona to the role a demo step is presented as. It exists only for the development
 * identity (the API refuses `x-cg-persona` elsewhere); with Entra the role comes from the token and there is nothing to
 * switch. Only personas of the current tenant are offered, because the list also carries a second-tenant persona that
 * exists to prove tenant isolation.
 */
export function useRoleSwitch(options: { enabled?: boolean } = {}): RoleSwitch {
  const auth = useAuth();
  const { session, roles } = useSession();
  const toast = useToast();
  const isDev = auth.dev !== undefined;
  const personas = useApiQuery('dev.personas', undefined, {
    enabled: (options.enabled ?? true) && isDev && auth.status === 'ready',
    staleTime: 5 * 60_000,
  });
  const tenantId = session?.tenant.id;
  const candidates = useMemo<Persona[]>(
    () =>
      personas.data?.enabled && tenantId
        ? personas.data.items.filter((persona) => persona.tenantId === tenantId)
        : [],
    [personas.data, tenantId],
  );
  const switchTo = useCallback(
    (persona: Persona) => {
      auth.dev?.selectPersona(persona.id);
      toast.info(`Now acting as ${persona.displayName}`);
    },
    [auth.dev, toast],
  );
  return {
    available: isDev && candidates.length > 0,
    actingAs: (role) => roles.includes(role),
    personaFor: (role) => candidates.find((persona) => persona.role === role) ?? null,
    switchTo,
  };
}
