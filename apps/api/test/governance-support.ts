import type { AuditEvent } from '@caseguard/schemas';
import { PERSONAS, type Harness } from './support/app-harness';

/** Shared helpers of the governance integration tests (not a test file itself). */

export const API = '/api/v1';
export const NOTE = 'Adjusted during the governance review';

export function putSetting(
  h: Harness,
  section: string,
  value: unknown,
  expectedVersion: number,
  persona: string = PERSONAS.admin,
) {
  return h.call(persona, {
    method: 'PUT',
    url: `${API}/governance/settings/${section}`,
    payload: { value, expectedVersion, changeNote: NOTE },
  });
}

export function putRoles(
  h: Harness,
  userId: string,
  roles: string[],
  expectedVersion: number,
  persona: string = PERSONAS.admin,
) {
  return h.call(persona, {
    method: 'PUT',
    url: `${API}/governance/users/${userId}/roles`,
    payload: { roles, expectedVersion, reason: 'Role review for the quarter' },
  });
}

export async function auditEvents(h: Harness, tenantId: string): Promise<AuditEvent[]> {
  return (await h.repos(tenantId).audit.list({ limit: 200 })).items;
}

export const ofAction = (list: AuditEvent[], action: string): AuditEvent[] =>
  list.filter((event) => event.action === action);

/** The roles that hold no governance permission. */
export const NON_ADMINS = [
  PERSONAS.engineer,
  PERSONAS.reviewer,
  PERSONAS.manager,
  PERSONAS.curator,
] as const;
