import { beforeAll, describe, expect, it } from 'vitest';
import type { AppEnvironment, Role } from '@caseguard/schemas';
import { AuthConfigurationError, AuthenticationError } from '../src/errors';
import {
  DevPersonaAuthenticator,
  EntraJwtAuthenticator,
  createAuthenticator,
  deriveEntraEndpoints,
  type CreateAuthenticatorOptions,
} from '../src/auth';
import {
  AUDIENCE,
  ISSUER_A,
  NOW,
  TENANT_A,
  bearer,
  createTestIdp,
  issueToken,
  type TestIdp,
} from './helpers/entra';

const lookupPersona = async () => null;
const ROLE_MAP: Record<string, Role> = { 'CaseGuard.Engineer': 'engineer' };
const entra = (extra: Partial<NonNullable<CreateAuthenticatorOptions['entra']>> = {}) => ({
  tenantId: TENANT_A,
  audience: AUDIENCE,
  issuer: null,
  jwksUri: null,
  tenantMap: { [TENANT_A]: 'tenant_contoso_support' },
  roleMap: ROLE_MAP,
  ...extra,
});

let idp: TestIdp;
beforeAll(async () => {
  idp = await createTestIdp();
});

describe('createAuthenticator: development identity (NFR-SEC-03)', () => {
  it('[NFR-SEC-03] throws for dev mode in production and staging', () => {
    for (const environment of ['production', 'staging'] as const) {
      expect(
        () =>
          createAuthenticator(
            { mode: 'dev', environment, devAuthEnabled: true },
            { lookupPersona },
          ),
        environment,
      ).toThrow(AuthConfigurationError);
    }
  });

  it('[NFR-SEC-03] throws for dev mode without the explicit DEV_AUTH_ENABLED switch', () => {
    expect(() =>
      createAuthenticator(
        { mode: 'dev', environment: 'local', devAuthEnabled: false },
        { lookupPersona },
      ),
    ).toThrow(/DEV_AUTH_ENABLED/);
  });

  it('[NFR-SEC-03] throws for unknown environment names (fail closed)', () => {
    expect(() =>
      createAuthenticator(
        { mode: 'dev', environment: 'prod' as AppEnvironment, devAuthEnabled: true },
        { lookupPersona },
      ),
    ).toThrow(AuthConfigurationError);
  });

  it('needs a persona directory', () => {
    expect(() =>
      createAuthenticator({ mode: 'dev', environment: 'local', devAuthEnabled: true }),
    ).toThrow(/lookupPersona/);
  });

  it('builds the dev authenticator for local, test and development', () => {
    for (const environment of ['local', 'test', 'development'] as const) {
      const authenticator = createAuthenticator(
        { mode: 'dev', environment, devAuthEnabled: true },
        { lookupPersona },
      );
      expect(authenticator).toBeInstanceOf(DevPersonaAuthenticator);
    }
  });

  it('[NFR-SEC-03] refuses DEV_AUTH_ENABLED=true in production-like environments even in entra mode', () => {
    for (const environment of ['production', 'staging'] as const) {
      expect(
        () =>
          createAuthenticator(
            { mode: 'entra', environment, devAuthEnabled: true, entra: entra() },
            { keyResolver: idp.keyResolver },
          ),
        environment,
      ).toThrow(/DEV_AUTH_ENABLED/);
    }
  });

  it('allows the switch to be on locally while entra is the active mode', () => {
    expect(() =>
      createAuthenticator(
        { mode: 'entra', environment: 'local', devAuthEnabled: true, entra: entra() },
        { keyResolver: idp.keyResolver },
      ),
    ).not.toThrow();
  });
});

describe('createAuthenticator: entra mode', () => {
  const production = (
    extra: Partial<CreateAuthenticatorOptions> = {},
  ): CreateAuthenticatorOptions => ({
    mode: 'entra',
    environment: 'production',
    devAuthEnabled: false,
    entra: entra(),
    ...extra,
  });

  it('requires an audience and a tenant or issuer', () => {
    expect(() =>
      createAuthenticator(production({ entra: entra({ audience: null }) }), {
        keyResolver: idp.keyResolver,
      }),
    ).toThrow(/ENTRA_AUDIENCE/);
    expect(() =>
      createAuthenticator(production({ entra: entra({ tenantId: null, issuer: null }) }), {
        keyResolver: idp.keyResolver,
      }),
    ).toThrow(/ENTRA_TENANT_ID or ENTRA_ISSUER/);
    expect(() =>
      createAuthenticator(production({ entra: undefined }), { keyResolver: idp.keyResolver }),
    ).toThrow(AuthConfigurationError);
  });

  it('derives the v2 issuer from the tenant id and rejects v1 tokens unless configured explicitly', async () => {
    const authenticator = createAuthenticator(production(), {
      keyResolver: idp.keyResolver,
      now: () => NOW,
    });
    expect(authenticator).toBeInstanceOf(EntraJwtAuthenticator);
    const v2 = await issueToken(idp, { issuer: ISSUER_A });
    await expect(authenticator.authenticate(bearer(v2))).resolves.toMatchObject({
      authMode: 'entra',
    });
    const v1 = await issueToken(idp, { issuer: deriveEntraEndpoints(TENANT_A).issuerV1 });
    await expect(authenticator.authenticate(bearer(v1))).rejects.toBeInstanceOf(
      AuthenticationError,
    );

    const pinnedToV1 = createAuthenticator(
      production({ entra: entra({ issuer: deriveEntraEndpoints(TENANT_A).issuerV1 }) }),
      { keyResolver: idp.keyResolver, now: () => NOW },
    );
    await expect(pinnedToV1.authenticate(bearer(v1))).resolves.toMatchObject({ authMode: 'entra' });
    await expect(pinnedToV1.authenticate(bearer(v2))).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('honours an explicitly configured issuer exactly', async () => {
    const authenticator = createAuthenticator(production({ entra: entra({ issuer: ISSUER_A }) }), {
      keyResolver: idp.keyResolver,
      now: () => NOW,
    });
    await expect(authenticator.authenticate(bearer(await issueToken(idp)))).resolves.toBeDefined();
    const other = await issueToken(idp, { issuer: 'https://login.microsoftonline.com/other/v2.0' });
    await expect(authenticator.authenticate(bearer(other))).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it('works with an explicit issuer and no tenant id', async () => {
    const authenticator = createAuthenticator(
      production({ entra: entra({ tenantId: null, issuer: ISSUER_A }) }),
      { keyResolver: idp.keyResolver, now: () => NOW },
    );
    await expect(authenticator.authenticate(bearer(await issueToken(idp)))).resolves.toBeDefined();
  });

  it('derives the JWKS endpoint but never accepts an insecure one in production', () => {
    expect(deriveEntraEndpoints(TENANT_A).jwksUri).toBe(
      `https://login.microsoftonline.com/${TENANT_A}/discovery/v2.0/keys`,
    );
    // No injected resolver: the default remote key set is built from the derived https endpoint.
    expect(() => createAuthenticator(production())).not.toThrow();
    expect(() =>
      createAuthenticator(
        production({ entra: entra({ jwksUri: 'http://keys.example.test/jwks' }) }),
      ),
    ).toThrow(/https/);
  });

  it('passes tolerance and the user hook through', async () => {
    const authenticator = createAuthenticator(
      production({ entra: entra({ clockToleranceSeconds: 0 }) }),
      {
        keyResolver: idp.keyResolver,
        now: () => NOW,
        resolveUser: async () => ({ userId: 'user_ava_engineer' }),
      },
    );
    const context = await authenticator.authenticate(bearer(await issueToken(idp)));
    expect(context.userId).toBe('user_ava_engineer');
    await expect(
      authenticator.authenticate(bearer(await issueToken(idp, { expiresInSeconds: -1 }))),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });
});
