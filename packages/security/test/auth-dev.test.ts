import { describe, expect, it, vi } from 'vitest';
import type { AppEnvironment } from '@caseguard/schemas';
import { AuthConfigurationError, AuthenticationError, type AuthFailureReason } from '../src/errors';
import { permissionsFor } from '../src/rbac';
import { DEV_PERSONA_HEADER, DevPersonaAuthenticator, type PersonaRecord } from '../src/auth/dev';

const PERSONAS: Record<string, PersonaRecord> = {
  user_ava_engineer: {
    id: 'user_ava_engineer',
    tenantId: 'tenant_contoso_support',
    displayName: 'Ava Engineer (synthetic)',
    role: 'engineer',
    email: 'ava.engineer@contoso.invalid',
  },
  user_alex_admin: {
    id: 'user_alex_admin',
    tenantId: 'tenant_contoso_support',
    displayName: 'Alex Admin (synthetic)',
    roles: ['administrator', 'reviewer'],
  },
  user_fabi_engineer: {
    id: 'user_fabi_engineer',
    tenantId: 'tenant_fabrikam_lab',
    displayName: 'Fabi Engineer (synthetic)',
    role: 'engineer',
  },
  user_disabled: {
    id: 'user_disabled',
    tenantId: 'tenant_contoso_support',
    displayName: 'Disabled (synthetic)',
    role: 'engineer',
    status: 'disabled',
  },
  user_no_role: {
    id: 'user_no_role',
    tenantId: 'tenant_contoso_support',
    displayName: 'No role (synthetic)',
  },
  user_mismatch: {
    id: 'someone_else',
    tenantId: 'tenant_contoso_support',
    displayName: 'Mismatch (synthetic)',
    role: 'administrator',
  },
};

const lookupPersona = vi.fn(async (id: string) => PERSONAS[id] ?? null);

function build(environment: AppEnvironment = 'local'): DevPersonaAuthenticator {
  return new DevPersonaAuthenticator({ allowDev: true, environment, lookupPersona });
}

async function reasonOf(promise: Promise<unknown>): Promise<AuthFailureReason> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as AuthenticationError).status).toBe(401);
    expect((error as AuthenticationError).message).toBe('Authentication failed');
    return (error as AuthenticationError).reason;
  }
  return expect.unreachable('expected authentication to fail');
}

describe('DevPersonaAuthenticator construction', () => {
  it('[NFR-SEC-03] refuses to be constructed without an explicit allowDev: true', () => {
    for (const allowDev of [false, undefined, 'true', 1, null]) {
      expect(
        () =>
          new DevPersonaAuthenticator({
            allowDev: allowDev as boolean,
            environment: 'local',
            lookupPersona,
          }),
      ).toThrow(AuthConfigurationError);
    }
  });

  it('[NFR-SEC-03] refuses production and staging even with allowDev: true', () => {
    for (const environment of ['production', 'staging'] as const) {
      expect(() => build(environment), environment).toThrow(AuthConfigurationError);
    }
  });

  it('[NFR-SEC-03] fails closed on unknown environment names', () => {
    for (const environment of ['prod', 'PRODUCTION', '', 'live'] as const) {
      expect(() => build(environment as AppEnvironment), environment).toThrow(
        AuthConfigurationError,
      );
    }
  });

  it('is available in local, test and development', () => {
    for (const environment of ['local', 'test', 'development'] as const) {
      expect(() => build(environment), environment).not.toThrow();
    }
  });
});

describe('DevPersonaAuthenticator.authenticate', () => {
  it('builds a synthetic dev context from the persona header', async () => {
    const context = await build().authenticate({ [DEV_PERSONA_HEADER]: 'user_ava_engineer' });
    expect(context).toEqual({
      userId: 'user_ava_engineer',
      tenantId: 'tenant_contoso_support',
      displayName: 'Ava Engineer (synthetic)',
      roles: ['engineer'],
      permissions: permissionsFor(['engineer']),
      authMode: 'dev',
      synthetic: true,
      subject: 'user_ava_engineer',
      email: 'ava.engineer@contoso.invalid',
    });
  });

  it('supports multi-role personas and personas of other tenants', async () => {
    const admin = await build().authenticate({ 'x-cg-persona': 'user_alex_admin' });
    expect(admin.roles).toEqual(['administrator', 'reviewer']);
    expect(admin.email).toBeNull();
    const fabi = await build().authenticate({ 'x-cg-persona': 'user_fabi_engineer' });
    expect(fabi.tenantId).toBe('tenant_fabrikam_lab');
  });

  it('reads the header case-insensitively, trims it and supports Fetch headers', async () => {
    await expect(
      build().authenticate({ 'X-CG-Persona': ' user_ava_engineer ' }),
    ).resolves.toBeDefined();
    await expect(
      build().authenticate(new Headers({ 'x-cg-persona': 'user_ava_engineer' })),
    ).resolves.toBeDefined();
  });

  it('rejects a missing or blank persona header', async () => {
    expect(await reasonOf(build().authenticate({}))).toBe('missing_credentials');
    expect(await reasonOf(build().authenticate({ 'x-cg-persona': '  ' }))).toBe(
      'missing_credentials',
    );
  });

  it('[NFR-SEC-03] rejects malformed persona values before touching the directory', async () => {
    lookupPersona.mockClear();
    for (const value of [
      '../../etc/passwd',
      'user a',
      "user_ava_engineer'; DROP TABLE users;--",
      'user_ava_engineer\r\nX-Injected: 1',
      'x'.repeat(121),
      '%00',
    ]) {
      expect(await reasonOf(build().authenticate({ 'x-cg-persona': value })), value).toBe(
        'malformed_credentials',
      );
    }
    expect(lookupPersona).not.toHaveBeenCalled();
  });

  it('rejects unknown personas, disabled personas and inconsistent directory records', async () => {
    expect(await reasonOf(build().authenticate({ 'x-cg-persona': 'user_nobody' }))).toBe(
      'unknown_persona',
    );
    expect(await reasonOf(build().authenticate({ 'x-cg-persona': 'user_disabled' }))).toBe(
      'user_disabled',
    );
    expect(await reasonOf(build().authenticate({ 'x-cg-persona': 'user_no_role' }))).toBe(
      'unknown_persona',
    );
    expect(await reasonOf(build().authenticate({ 'x-cg-persona': 'user_mismatch' }))).toBe(
      'unknown_persona',
    );
  });

  it('rejects ambiguous (repeated) persona headers', async () => {
    const reason = await reasonOf(
      build().authenticate({ 'x-cg-persona': ['user_ava_engineer', 'user_alex_admin'] }),
    );
    expect(reason).toBe('malformed_credentials');
  });

  it('does not swallow directory failures: they are platform errors, not 401s', async () => {
    const failing = new DevPersonaAuthenticator({
      allowDev: true,
      environment: 'local',
      lookupPersona: async () => {
        throw new Error('database unavailable');
      },
    });
    await expect(failing.authenticate({ 'x-cg-persona': 'user_ava_engineer' })).rejects.toThrow(
      'database unavailable',
    );
  });

  it('supports a custom header name', async () => {
    const custom = new DevPersonaAuthenticator({
      allowDev: true,
      environment: 'test',
      lookupPersona,
      headerName: 'x-test-user',
    });
    await expect(
      custom.authenticate({ 'x-test-user': 'user_ava_engineer' }),
    ).resolves.toBeDefined();
    expect(await reasonOf(custom.authenticate({ 'x-cg-persona': 'user_ava_engineer' }))).toBe(
      'missing_credentials',
    );
  });
});
