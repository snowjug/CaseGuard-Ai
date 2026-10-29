import { ROUTES, type Permission, type Role, type RouteId } from '@caseguard/schemas';
import { hasPermission } from '@caseguard/security';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import {
  CONTOSO,
  FABRIKAM,
  PERSONAS,
  createHarness,
  openSharedDatabase,
  type Harness,
} from './support/app-harness';

/*
 * Authentication and authorization of every route of the governance, system and search groups,
 * derived from the frozen route contract: the permission of each route decides which personas must
 * be refused, so a permission that changes in the contract changes the expectation with it.
 */

const GROUP_ROUTES = [
  'governance.get',
  'governance.update',
  'governance.prompts',
  'governance.users',
  'governance.assignRoles',
  'governance.audit',
  'governance.auditVerify',
  'governance.reviews',
  'governance.export',
  'system.health',
  'system.metrics',
  'system.provider',
  'search.global',
] as const satisfies readonly RouteId[];

const PERSONA_ROLES: readonly { persona: string; role: Role }[] = [
  { persona: PERSONAS.engineer, role: 'engineer' },
  { persona: PERSONAS.reviewer, role: 'reviewer' },
  { persona: PERSONAS.manager, role: 'manager' },
  { persona: PERSONAS.curator, role: 'skill_curator' },
  { persona: PERSONAS.admin, role: 'administrator' },
];

let database: Database;
let h: Harness;

beforeAll(async () => {
  database = await openSharedDatabase();
  h = await createHarness({ database });
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);

afterAll(async () => {
  await h.close();
  await database.close();
});

function requestFor(id: (typeof GROUP_ROUTES)[number]): InjectOptions {
  const { method, path } = ROUTES[id];
  const url = path.replace(':section', 'export_controls').replace(':userId', 'user_ava_engineer');
  if (method === 'GET') return { method, url: id === 'search.global' ? `${url}?q=zephyr` : url };
  // An empty body fails validation, so a caller that passes authorization still changes nothing.
  return { method, url, payload: {} };
}

const permissionOf = (id: (typeof GROUP_ROUTES)[number]): Permission => ROUTES[id].permission;

describe.each(GROUP_ROUTES)('%s', (id) => {
  it('answers 401 to a caller without credentials, with a generic problem', async () => {
    const res = await h.call(null, requestFor(id));
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.data).toMatchObject({ code: 'unauthenticated', detail: 'Authentication failed' });
  });

  it('refuses the roles without its permission (403, audited in their tenant only)', async () => {
    const permission = permissionOf(id);
    const refused: string[] = [];
    for (const { persona, role } of PERSONA_ROLES) {
      const res = await h.call(persona, requestFor(id));
      if (hasPermission([role], permission)) {
        expect([401, 403]).not.toContain(res.statusCode);
      } else {
        refused.push(persona);
        expect(res.statusCode).toBe(403);
        expect(res.data.code).toBe('forbidden');
      }
    }

    const denied = (action: string) => (event: { action: string; targetId: string | null }) =>
      event.action === action && event.targetId === id;
    const inContoso = (await h.repos(CONTOSO).audit.list({ limit: 200 })).items.filter(
      denied('access.denied'),
    );
    expect(inContoso.map((event) => event.actorId).sort()).toEqual([...refused].sort());
    const inFabrikam = (await h.repos(FABRIKAM).audit.list({ limit: 200 })).items.filter(
      denied('access.denied'),
    );
    expect(inFabrikam).toEqual([]);
  });
});
