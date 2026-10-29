import { permissionsFor, type AuthContext } from '@caseguard/security';
import type { Role } from '@caseguard/schemas';
import { buildRequestContext } from '../../src/http/context-factory';
import type { RequestContext } from '../../src/http/request-context';
import { CONTOSO, FABRIKAM, PERSONAS, type Harness } from './app-harness';

const ROLE_OF: Record<string, { role: Role; tenantId: string; name: string }> = {
  [PERSONAS.engineer]: { role: 'engineer', tenantId: CONTOSO, name: 'Ava Engineer (synthetic)' },
  [PERSONAS.reviewer]: { role: 'reviewer', tenantId: CONTOSO, name: 'Riley Reviewer (synthetic)' },
  [PERSONAS.manager]: { role: 'manager', tenantId: CONTOSO, name: 'Morgan Manager (synthetic)' },
  [PERSONAS.curator]: {
    role: 'skill_curator',
    tenantId: CONTOSO,
    name: 'Casey Curator (synthetic)',
  },
  [PERSONAS.admin]: { role: 'administrator', tenantId: CONTOSO, name: 'Alex Admin (synthetic)' },
  [PERSONAS.otherTenantEngineer]: {
    role: 'engineer',
    tenantId: FABRIKAM,
    name: 'Fabi Engineer (synthetic)',
  },
};

/**
 * A request context for a persona without going through HTTP: what services and jobs receive.
 * Use it to test service functions directly; use `harness.call` to test routes.
 */
export function contextFor(
  harness: Harness,
  persona: string = PERSONAS.engineer,
  signal: AbortSignal = new AbortController().signal,
): RequestContext {
  const known = ROLE_OF[persona];
  if (known === undefined) throw new Error(`Unknown test persona ${persona}`);
  const auth: AuthContext = {
    userId: persona,
    tenantId: known.tenantId,
    displayName: known.name,
    roles: [known.role],
    permissions: permissionsFor([known.role]),
    authMode: 'dev',
    synthetic: true,
    subject: persona,
    email: null,
  };
  return buildRequestContext(harness.infra, {
    requestId: 'req_service_test',
    auth,
    permission: null,
    signal,
    logger: harness.infra.logger,
  });
}
