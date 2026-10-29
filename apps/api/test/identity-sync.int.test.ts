import type { VerifiedEntraClaims } from '@caseguard/security';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import { IDENTITY_SYNC_TTL_MS, createIdentityResolver } from '../src/identity-sync';
import {
  CONTOSO,
  FABRIKAM,
  createHarness,
  openSharedDatabase,
  type Harness,
} from './support/app-harness';

/*
 * Just-in-time provisioning of Entra users. The token path itself is covered in the security package;
 * this covers what the API does with a verified identity. Not validated against a live Entra tenant.
 */

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

let sequence = 0;
const nextObjectId = (): string => `entra-oid-${Date.now().toString(36)}-${(sequence += 1)}`;

function claims(overrides: Partial<VerifiedEntraClaims> = {}): VerifiedEntraClaims {
  return {
    entraTenantId: '11111111-1111-4111-8111-111111111111',
    tenantId: CONTOSO,
    objectId: nextObjectId(),
    roles: ['engineer'],
    displayName: 'Nora Entra',
    email: 'nora.entra@contoso.example',
    raw: {},
    ...overrides,
  };
}

const resolver = () =>
  createIdentityResolver({ repos: h.infra.repos, now: h.clock.now, logger: h.infra.logger });

/** Counts the profile writes the resolver makes (everything else is passed through untouched). */
function countProfileWrites(): { count: () => number; restore: () => void } {
  const original = h.infra.repos.forTenant.bind(h.infra.repos);
  let writes = 0;
  const spy = vi.spyOn(h.infra.repos, 'forTenant').mockImplementation((scope) => {
    const repos = original(scope);
    const governance = Object.create(repos.governance) as typeof repos.governance;
    governance.upsertIdentityUser = (input) => {
      writes += 1;
      return repos.governance.upsertIdentityUser(input);
    };
    return { ...repos, governance };
  });
  return { count: () => writes, restore: () => spy.mockRestore() };
}

const storedUser = (userId: string, tenantId = CONTOSO) =>
  h.repos(tenantId).governance.getUser(userId);

describe('just-in-time user provisioning', () => {
  it('stores a user the first time they sign in and returns their profile', async () => {
    const identity = claims();
    const resolved = await resolver()(identity);
    expect(resolved).toMatchObject({
      userId: identity.objectId,
      displayName: 'Nora Entra',
      email: 'nora.entra@contoso.example',
      synthetic: false,
    });
    expect(resolved.disabled).toBeUndefined();
    expect(await storedUser(identity.objectId)).toMatchObject({
      roles: ['engineer'],
      status: 'active',
      synthetic: false,
      version: 1,
    });
  });

  it('keeps users of different tenants apart', async () => {
    const identity = claims();
    await resolver()(identity);
    await resolver()({ ...identity, tenantId: FABRIKAM, roles: ['manager'] });
    expect((await storedUser(identity.objectId, CONTOSO))?.roles).toEqual(['engineer']);
    expect((await storedUser(identity.objectId, FABRIKAM))?.roles).toEqual(['manager']);
  });

  it('does not write an unchanged profile again until the sync interval has passed', async () => {
    const writes = countProfileWrites();
    try {
      const identity = claims();
      const resolve = resolver();
      await resolve(identity);
      await resolve(identity);
      await resolve(identity);
      expect(writes.count()).toBe(1);

      h.clock.advance(IDENTITY_SYNC_TTL_MS + 1_000);
      await resolve(identity);
      expect(writes.count()).toBe(2);
    } finally {
      writes.restore();
    }
  });

  it('writes again as soon as the token carries different roles, name or e-mail', async () => {
    const identity = claims();
    const resolve = resolver();
    await resolve(identity);
    expect((await storedUser(identity.objectId))?.roles).toEqual(['engineer']);

    await resolve({ ...identity, roles: ['engineer', 'reviewer'] });
    const promoted = await storedUser(identity.objectId);
    expect(promoted?.roles).toEqual(['engineer', 'reviewer']);
    expect(promoted?.version).toBe(2);

    await resolve({ ...identity, roles: ['engineer', 'reviewer'], displayName: 'Nora E. Entra' });
    expect((await storedUser(identity.objectId))?.displayName).toBe('Nora E. Entra');
  });

  it('never re-enables a user an administrator disabled, and reports them as disabled', async () => {
    const identity = claims();
    const resolve = resolver();
    await resolve(identity);
    await database.query(
      `UPDATE users SET status = 'disabled', data = jsonb_set(data, '{status}', '"disabled"')
        WHERE tenant_id = $1 AND id = $2`,
      [CONTOSO, identity.objectId],
    );

    // Same profile (inside the interval) and a changed one (forces a sync): disabled either way.
    expect((await resolve(identity)).disabled).toBe(true);
    const changed = await resolve({ ...identity, roles: ['reviewer'] });
    expect(changed.disabled).toBe(true);
    expect((await storedUser(identity.objectId))?.status).toBe('disabled');
  });

  it('falls back to the e-mail, then the object id, when the token has no display name', async () => {
    const withEmail = claims({ displayName: null });
    expect((await resolver()(withEmail)).displayName).toBe('nora.entra@contoso.example');
    const bare = claims({ displayName: null, email: null });
    expect((await resolver()(bare)).displayName).toBe(bare.objectId);
  });

  it('keeps a stored e-mail when a later token carries none', async () => {
    const identity = claims();
    const resolve = resolver();
    await resolve(identity);
    const later = await resolve({ ...identity, email: null });
    expect(later.email).toBe('nora.entra@contoso.example');
  });

  it('lets the user in with what is stored when the profile cannot be written', async () => {
    const identity = claims();
    await resolver()(identity);
    const original = h.infra.repos.forTenant.bind(h.infra.repos);
    const spy = vi.spyOn(h.infra.repos, 'forTenant').mockImplementation((scope) => {
      const repos = original(scope);
      const governance = Object.create(repos.governance) as typeof repos.governance;
      governance.upsertIdentityUser = () => Promise.reject(new Error('connection lost'));
      return { ...repos, governance };
    });
    try {
      const resolved = await resolver()({ ...identity, roles: ['reviewer'] });
      expect(resolved).toMatchObject({ userId: identity.objectId, displayName: 'Nora Entra' });
      expect(h.logs().some((line) => line.event === 'identity.sync_failed')).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
