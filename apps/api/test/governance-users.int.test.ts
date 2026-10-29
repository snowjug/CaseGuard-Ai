import { loadConfig } from '@caseguard/config';
import { AGENT_NAMES, PromptVersionSchema, UserSchema, type AuditEvent } from '@caseguard/schemas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS, resetTestDatabase } from '../src/db/testing';
import { ConflictError } from '../src/errors';
import { buildRequestContext } from '../src/http/context-factory';
import { assignRoles } from '../src/services/governance';
import { API, NON_ADMINS, auditEvents, ofAction, putRoles } from './governance-support';
import { buildPromptVersion } from './builders';
import {
  CONTOSO,
  FABRIKAM,
  PERSONAS,
  createHarness,
  openSharedDatabase,
  type Harness,
} from './support/app-harness';

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

beforeEach(async () => {
  await resetTestDatabase(database);
});

const roles = (userId: string, next: string[], version: number, persona?: string) =>
  putRoles(h, userId, next, version, persona);
const events = (tenantId: string = CONTOSO): Promise<AuditEvent[]> => auditEvents(h, tenantId);

describe('[NFR-SEC-02] governance.users and governance.assignRoles', () => {
  it('lists only this tenant’s users and audits the read', async () => {
    const res = await h.call(PERSONAS.admin, { method: 'GET', url: `${API}/governance/users` });
    expect(res.statusCode).toBe(200);
    const users = (res.data.items as unknown[]).map((item) => UserSchema.parse(item));
    expect(users.map((user) => user.id).sort()).toEqual([
      'user_alex_admin',
      'user_ava_engineer',
      'user_casey_curator',
      'user_morgan_manager',
      'user_riley_reviewer',
    ]);
    expect(users.every((user) => user.tenantId === CONTOSO)).toBe(true);
    expect(ofAction(await events(), 'api.governance.users')).toHaveLength(1);

    for (const persona of [PERSONAS.engineer, PERSONAS.manager, PERSONAS.reviewer]) {
      const refused = await h.call(persona, { method: 'GET', url: `${API}/governance/users` });
      expect(refused.statusCode).toBe(403);
    }
  });

  it('replaces roles, bumps the version and audits before/after in the same step', async () => {
    const res = await roles('user_ava_engineer', ['reviewer', 'engineer', 'engineer'], 1);
    expect(res.statusCode).toBe(200);
    const updated = UserSchema.parse(res.data);
    expect(updated).toMatchObject({
      id: 'user_ava_engineer',
      roles: ['engineer', 'reviewer'],
      version: 2,
    });

    const written = ofAction(await events(), 'roles.assigned');
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      outcome: 'success',
      actorId: PERSONAS.admin,
      targetType: 'user',
      targetId: 'user_ava_engineer',
      details: {
        userId: 'user_ava_engineer',
        fromRoles: ['engineer'],
        toRoles: ['engineer', 'reviewer'],
        fromVersion: 1,
        toVersion: 2,
      },
    });
    expect(JSON.stringify(written[0]?.details)).not.toContain('quarter');

    // The new role takes effect on the next request: reviewers hold audit:read.
    const audit = await h.call(PERSONAS.engineer, { method: 'GET', url: `${API}/audit` });
    expect(audit.statusCode).toBe(200);
  });

  it('[NFR-REL-01] refuses a stale user version with 409', async () => {
    expect((await roles('user_ava_engineer', ['reviewer'], 1)).statusCode).toBe(200);
    const stale = await roles('user_ava_engineer', ['manager'], 1);
    expect(stale.statusCode).toBe(409);
    expect(stale.data.code).toBe('version_conflict');
    const user = await h.repos(CONTOSO).governance.getUser('user_ava_engineer');
    expect(user?.roles).toEqual(['reviewer']);
    expect(ofAction(await events(), 'roles.assigned')).toHaveLength(1);
  });

  it('rejects an empty or unknown role set with 422', async () => {
    const empty = await roles('user_ava_engineer', [], 1);
    expect(empty.statusCode).toBe(422);
    expect(empty.data.errors.map((issue: { path: string }) => issue.path)).toContain('body.roles');
    const unknown = await roles('user_ava_engineer', ['superuser'], 1);
    expect(unknown.statusCode).toBe(422);
    expect((await h.repos(CONTOSO).governance.getUser('user_ava_engineer'))?.version).toBe(1);
  });

  it('refuses removing the last administrator, records the refusal, and allows it once another exists', async () => {
    const refused = await roles('user_alex_admin', ['manager'], 1);
    expect(refused.statusCode).toBe(409);
    expect(refused.data.code).toBe('conflict');
    expect(refused.data.detail).toContain('at least one active administrator');
    const alex = await h.repos(CONTOSO).governance.getUser('user_alex_admin');
    expect(alex).toMatchObject({ roles: ['administrator'], version: 1 });
    const trail = ofAction(await events(), 'roles.assigned');
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      outcome: 'denied',
      targetId: 'user_alex_admin',
      details: { userId: 'user_alex_admin', reason: 'last_administrator' },
    });

    expect((await roles('user_riley_reviewer', ['reviewer', 'administrator'], 1)).statusCode).toBe(
      200,
    );
    const allowed = await roles('user_alex_admin', ['manager'], 1);
    expect(allowed.statusCode).toBe(200);
    expect(UserSchema.parse(allowed.data).roles).toEqual(['manager']);

    // Alex lost the administrator role; Riley is now the last administrator.
    const lostAccess = await h.call(PERSONAS.admin, {
      method: 'GET',
      url: `${API}/governance/settings`,
    });
    expect(lostAccess.statusCode).toBe(403);
    const lastOne = await roles('user_riley_reviewer', ['reviewer'], 2, PERSONAS.reviewer);
    expect(lastOne.statusCode).toBe(409);
  });

  it('answers 404 for a user of another tenant in both directions', async () => {
    await h.repos(FABRIKAM).governance.updateUserRoles('user_fabi_engineer', ['administrator'], 1);
    const intoOther = await roles('user_fabi_engineer', ['reviewer'], 1);
    expect(intoOther.statusCode).toBe(404);
    const fromOther = await roles(
      'user_ava_engineer',
      ['reviewer'],
      1,
      PERSONAS.otherTenantEngineer,
    );
    expect(fromOther.statusCode).toBe(404);
    expect((await roles('user_nobody', ['reviewer'], 1)).statusCode).toBe(404);

    expect((await h.repos(FABRIKAM).governance.getUser('user_fabi_engineer'))?.roles).toEqual([
      'administrator',
    ]);
    expect((await h.repos(CONTOSO).governance.getUser('user_ava_engineer'))?.roles).toEqual([
      'engineer',
    ]);

    const theirUsers = await h.call(PERSONAS.otherTenantEngineer, {
      method: 'GET',
      url: `${API}/governance/users`,
    });
    expect(
      (theirUsers.data.items as { tenantId: string }[]).every((user) => user.tenantId === FABRIKAM),
    ).toBe(true);
    expect(theirUsers.data.items).toHaveLength(1);
  });

  it('is limited to administrators', async () => {
    for (const persona of NON_ADMINS) {
      expect((await roles('user_ava_engineer', ['reviewer'], 1, persona)).statusCode).toBe(403);
    }
    expect((await h.repos(CONTOSO).governance.getUser('user_ava_engineer'))?.version).toBe(1);
  });

  it('[NFR-SEC-02] answers 409 in Entra mode, where roles come from token claims, and records the refusal', async () => {
    // Entra requests cannot be authenticated without a live key set, so the service runs on a real
    // request context (real repositories and audit chain) whose configuration says Entra.
    const auth = await h.infra.authenticator.authenticate({ 'x-cg-persona': PERSONAS.admin });
    const base = buildRequestContext(h.infra, {
      requestId: 'req-entra-mode',
      auth,
      permission: 'roles:manage',
      signal: new AbortController().signal,
      logger: h.infra.logger,
    });
    const entra = loadConfig({
      APP_ENV: 'test',
      DATABASE_URL: 'pglite://memory',
      AUTH_MODE: 'entra',
      ENTRA_TENANT_ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      ENTRA_AUDIENCE: 'api://caseguard-test',
      ENTRA_TENANT_MAP: '{"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa":"tenant_contoso_support"}',
    });
    const error = await assignRoles({ ...base, config: entra }, 'user_ava_engineer', {
      roles: ['reviewer'],
      expectedVersion: 1,
      reason: 'Role review for the quarter',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).status).toBe(409);
    expect((error as ConflictError).message).toBe('Roles are managed in Microsoft Entra ID');
    expect(await h.repos(CONTOSO).governance.getUser('user_ava_engineer')).toMatchObject({
      roles: ['engineer'],
      version: 1,
    });
    const trail = ofAction(await events(), 'roles.assigned');
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      outcome: 'denied',
      actorId: PERSONAS.admin,
      details: { userId: 'user_ava_engineer', reason: 'entra_managed' },
    });
  });
});

describe('[FR-GV-01] governance.prompts', () => {
  it('lists the versioned prompts of every agent, tenant-stamped and schema-valid', async () => {
    const res = await h.call(PERSONAS.admin, { method: 'GET', url: `${API}/governance/prompts` });
    expect(res.statusCode).toBe(200);
    const prompts = (res.data.items as unknown[]).map((item) => PromptVersionSchema.parse(item));
    expect(new Set(prompts.map((prompt) => prompt.agent))).toEqual(new Set(AGENT_NAMES));
    for (const prompt of prompts) {
      expect(prompt.tenantId).toBe(CONTOSO);
      expect(prompt.templateHash).toMatch(/^[a-f0-9]{64}$/);
      expect(prompt.status).toBe('active');
    }
  });

  it('also lists older versions that this tenant recorded, newest first within an agent', async () => {
    await h.repos(CONTOSO).telemetry.upsertPromptVersions([
      buildPromptVersion({
        id: 'prompt_quality_judge_0.9.0',
        agent: 'quality_judge',
        version: '0.9.0',
        status: 'retired',
      }),
    ]);
    const res = await h.call(PERSONAS.admin, { method: 'GET', url: `${API}/governance/prompts` });
    const judge = (res.data.items as { agent: string; version: string; status: string }[]).filter(
      (prompt) => prompt.agent === 'quality_judge',
    );
    expect(judge.map((prompt) => `${prompt.version}:${prompt.status}`)).toEqual([
      '1.0.0:active',
      '0.9.0:retired',
    ]);

    const other = await h.call(PERSONAS.otherTenantEngineer, {
      method: 'GET',
      url: `${API}/governance/prompts`,
    });
    expect(other.statusCode).toBe(403);
  });

  it('is limited to governance:read holders', async () => {
    const refused = await h.call(PERSONAS.engineer, {
      method: 'GET',
      url: `${API}/governance/prompts`,
    });
    expect(refused.statusCode).toBe(403);
    const anonymous = await h.call(null, { method: 'GET', url: `${API}/governance/prompts` });
    expect(anonymous.statusCode).toBe(401);
  });
});
