import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT, errors as joseErrors, generateKeyPair } from 'jose';
import type { Role } from '@caseguard/schemas';
import {
  AuthConfigurationError,
  AuthenticationError,
  AuthorizationError,
  IdentityProviderUnavailableError,
  type AuthFailureReason,
} from '../src/errors';
import { permissionsFor } from '../src/rbac';
import {
  EntraJwtAuthenticator,
  type EntraJwtAuthenticatorOptions,
  type VerifiedEntraClaims,
} from '../src/auth/entra';
import {
  AUDIENCE,
  ISSUER_A,
  ISSUER_B,
  NOW,
  NOW_SECONDS,
  OID,
  TENANT_A,
  TENANT_B,
  bearer,
  createTestIdp,
  issueToken,
  unsecuredToken,
  type TestIdp,
} from './helpers/entra';

const ROLE_MAP: Record<string, Role> = {
  'CaseGuard.Engineer': 'engineer',
  'CaseGuard.Reviewer': 'reviewer',
  'CaseGuard.Manager': 'manager',
  'CaseGuard.SkillCurator': 'skill_curator',
  'CaseGuard.Administrator': 'administrator',
};

let idp: TestIdp;
let otherIdp: TestIdp;

beforeAll(async () => {
  idp = await createTestIdp('RS256', 'k1');
  otherIdp = await createTestIdp('RS256', 'k1'); // same kid, different key material
});

function build(overrides: Partial<EntraJwtAuthenticatorOptions> = {}): EntraJwtAuthenticator {
  return new EntraJwtAuthenticator({
    issuer: ISSUER_A,
    audience: AUDIENCE,
    tenantMap: { [TENANT_A]: 'tenant_contoso_support' },
    roleMap: ROLE_MAP,
    keyResolver: idp.keyResolver,
    now: () => NOW,
    ...overrides,
  });
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return expect.unreachable('expected the authentication attempt to be rejected');
}

async function expectRejected(
  authenticator: EntraJwtAuthenticator,
  headers: Record<string, string | string[] | undefined>,
  reason: AuthFailureReason,
): Promise<void> {
  const error = await failureOf(authenticator.authenticate(headers));
  expect(error).toBeInstanceOf(AuthenticationError);
  const auth = error as AuthenticationError;
  expect(auth.status).toBe(401);
  expect(auth.code).toBe('unauthenticated');
  expect(auth.message).toBe('Authentication failed'); // generic: nothing about why
  expect(auth.reason).toBe(reason);
}

describe('EntraJwtAuthenticator: valid tokens', () => {
  it('[NFR-SEC-03] accepts a correctly signed token and maps tenant, roles and identity', async () => {
    const context = await build().authenticate(bearer(await issueToken(idp)));
    expect(context).toEqual({
      userId: OID,
      tenantId: 'tenant_contoso_support',
      displayName: 'Ava Synthetic',
      roles: ['engineer'],
      permissions: permissionsFor(['engineer']),
      authMode: 'entra',
      synthetic: false,
      subject: OID,
      email: 'ava@contoso.example',
    });
  });

  it('maps several roles, ignores unknown ones and de-duplicates', async () => {
    const token = await issueToken(idp, {
      claims: {
        roles: ['CaseGuard.Reviewer', 'Some.Other.App.Role', 'CaseGuard.Reviewer', 42, null],
      },
    });
    const context = await build().authenticate(bearer(token));
    expect(context.roles).toEqual(['reviewer']);
    expect(context.permissions).toContain('evidence:review');
    expect(context.permissions).not.toContain('case:ingest');
  });

  it('never grants more than the mapped roles allow (administrator is explicit)', async () => {
    const token = await issueToken(idp, { claims: { roles: ['CaseGuard.Administrator'] } });
    const context = await build().authenticate(bearer(token));
    expect(context.permissions).toContain('governance:write');
  });

  it('matches the tenant case-insensitively and accepts any configured issuer or audience', async () => {
    const authenticator = build({
      issuer: [ISSUER_A, ISSUER_B],
      audience: [AUDIENCE, 'api://other'],
      tenantMap: { [TENANT_A.toUpperCase()]: 'tenant_contoso_support' },
    });
    const upper = await issueToken(idp, { claims: { tid: TENANT_A.toUpperCase() } });
    await expect(authenticator.authenticate(bearer(upper))).resolves.toMatchObject({
      tenantId: 'tenant_contoso_support',
    });
    const other = await issueToken(idp, { audience: 'api://other' });
    await expect(authenticator.authenticate(bearer(other))).resolves.toBeDefined();
  });

  it('reads the Authorization header case-insensitively and from Fetch-style headers', async () => {
    const token = await issueToken(idp);
    const authenticator = build();
    await expect(
      authenticator.authenticate({ Authorization: `Bearer ${token}` }),
    ).resolves.toBeDefined();
    await expect(
      authenticator.authenticate({ authorization: `bearer ${token}` }),
    ).resolves.toBeDefined();
    await expect(
      authenticator.authenticate(new Headers({ authorization: `Bearer ${token}` })),
    ).resolves.toBeDefined();
  });

  it('falls back to the user principal name for email and the object id for the display name', async () => {
    const token = await issueToken(idp, {
      claims: {
        name: undefined,
        preferred_username: undefined,
        email: undefined,
        upn: 'ava@fabrikam.example',
      },
    });
    const context = await build().authenticate(bearer(token));
    expect(context.displayName).toBe(OID);
    expect(context.email).toBe('ava@fabrikam.example');
  });

  it('strips control and bidi characters from the display name', async () => {
    const token = await issueToken(idp, { claims: { name: 'Ava\u202E\u0000 Synthetic\u200B' } });
    expect((await build().authenticate(bearer(token))).displayName).toBe('Ava Synthetic');
  });

  it('supports other asymmetric algorithms when configured (EC P-256)', async () => {
    const ec = await createTestIdp('ES256', 'ec1');
    const authenticator = build({ keyResolver: ec.keyResolver, algorithms: ['ES256'] });
    await expect(authenticator.authenticate(bearer(await issueToken(ec)))).resolves.toBeDefined();
    // The default (RS256 only) refuses an ES256 token even though the signature is valid.
    const strict = build({ keyResolver: ec.keyResolver });
    await expectRejected(strict, bearer(await issueToken(ec)), 'invalid_algorithm');
  });
});

describe('EntraJwtAuthenticator: token validation', () => {
  it('[NFR-SEC-03] rejects a wrong issuer', async () => {
    const token = await issueToken(idp, { issuer: 'https://evil.example.com/v2.0' });
    await expectRejected(build(), bearer(token), 'invalid_issuer');
  });

  it('[NFR-SEC-03] rejects a wrong audience', async () => {
    const token = await issueToken(idp, { audience: 'api://someone-else' });
    await expectRejected(build(), bearer(token), 'invalid_audience');
  });

  it('[NFR-SEC-03] rejects an expired token but tolerates small clock skew', async () => {
    await expectRejected(
      build(),
      bearer(await issueToken(idp, { expiresInSeconds: -120 })),
      'token_expired',
    );
    await expect(
      build().authenticate(bearer(await issueToken(idp, { expiresInSeconds: -10 }))),
    ).resolves.toBeDefined();
  });

  it('[NFR-SEC-03] rejects a token that is not valid yet but tolerates small clock skew', async () => {
    await expectRejected(
      build(),
      bearer(await issueToken(idp, { notBeforeInSeconds: 120 })),
      'token_not_yet_valid',
    );
    await expect(
      build().authenticate(bearer(await issueToken(idp, { notBeforeInSeconds: 10 }))),
    ).resolves.toBeDefined();
  });

  it('respects a tighter configured clock tolerance', async () => {
    const strict = build({ clockToleranceSeconds: 0 });
    await expectRejected(
      strict,
      bearer(await issueToken(idp, { expiresInSeconds: -1 })),
      'token_expired',
    );
  });

  it('[NFR-SEC-03] rejects a token without an expiry', async () => {
    await expectRejected(
      build(),
      bearer(await issueToken(idp, { expiresInSeconds: null })),
      'missing_claim',
    );
  });

  it('[NFR-SEC-03] rejects a token signed with a different key (same kid)', async () => {
    const forged = await issueToken(otherIdp);
    await expectRejected(build(), bearer(forged), 'invalid_signature');
  });

  it('[NFR-SEC-03] rejects a token whose payload was tampered with after signing', async () => {
    const token = await issueToken(idp);
    const [header, , signature] = token.split('.');
    const payload = Buffer.from(
      JSON.stringify({
        tid: TENANT_A,
        oid: OID,
        roles: ['CaseGuard.Administrator'],
        iss: ISSUER_A,
        aud: AUDIENCE,
        exp: NOW_SECONDS + 3600,
      }),
    ).toString('base64url');
    await expectRejected(build(), bearer(`${header}.${payload}.${signature}`), 'invalid_signature');
  });

  it('[NFR-SEC-03] rejects tokens whose kid is unknown to the key set', async () => {
    const token = await issueToken(idp, { kid: 'rotated-away' });
    await expectRejected(build(), bearer(token), 'unknown_signing_key');
  });

  it('[NFR-SEC-03] rejects alg "none" tokens even when every claim is valid', async () => {
    const error = await failureOf(build().authenticate(bearer(unsecuredToken())));
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as AuthenticationError).status).toBe(401);
  });

  it('[NFR-SEC-03] rejects algorithm-confusion tokens (HS256 keyed with the public key)', async () => {
    const secret = new TextEncoder().encode(JSON.stringify(idp.publicJwk));
    const hmacToken = await new SignJWT({
      tid: TENANT_A,
      oid: OID,
      roles: ['CaseGuard.Administrator'],
    })
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setIssuer(ISSUER_A)
      .setAudience(AUDIENCE)
      .setExpirationTime(NOW_SECONDS + 3600)
      .sign(secret);
    await expectRejected(build(), bearer(hmacToken), 'invalid_algorithm');
  });

  it('[NFR-SEC-03] rejects tokens signed with a key type that does not match the header algorithm', async () => {
    const { privateKey } = await generateKeyPair('ES256');
    const token = await issueToken(idp, { alg: 'ES256', signWith: privateKey });
    const error = await failureOf(build().authenticate(bearer(token)));
    expect(error).toBeInstanceOf(AuthenticationError);
  });

  it('rejects garbage that is not a JWT', async () => {
    for (const junk of ['abc', 'a.b', 'a.b.c', '....', 'eyJhbGciOiJSUzI1NiJ9.e30.']) {
      const error = await failureOf(build().authenticate(bearer(junk)));
      expect(error, junk).toBeInstanceOf(AuthenticationError);
    }
  });
});

describe('EntraJwtAuthenticator: tenancy and roles', () => {
  it('[NFR-SEC-01] rejects a token without a tid claim', async () => {
    const token = await issueToken(idp, { claims: { tid: undefined } });
    await expectRejected(build(), bearer(token), 'missing_claim');
  });

  it('[NFR-SEC-01] rejects a validly signed token from an unmapped tenant', async () => {
    const token = await issueToken(idp, { claims: { tid: TENANT_B } });
    await expectRejected(build(), bearer(token), 'unknown_tenant');
  });

  it('[NFR-SEC-01] rejects a token issued for another tenant (issuer mismatch)', async () => {
    const token = await issueToken(idp, { issuer: ISSUER_B, claims: { tid: TENANT_B } });
    await expectRejected(build(), bearer(token), 'invalid_issuer');
    // Even when both tenants are known, the issuer allowlist is what keeps tenant B out.
    const bothKnown = build({ tenantMap: { [TENANT_A]: 'tenant_a', [TENANT_B]: 'tenant_b' } });
    await expectRejected(bothKnown, bearer(token), 'invalid_issuer');
  });

  it('[NFR-SEC-01] treats prototype property names as unknown tenants rather than crashing', async () => {
    for (const tid of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const token = await issueToken(idp, { claims: { tid } });
      await expectRejected(build(), bearer(token), 'unknown_tenant');
    }
  });

  it('rejects an unusable object id', async () => {
    await expectRejected(
      build(),
      bearer(await issueToken(idp, { claims: { oid: undefined } })),
      'missing_claim',
    );
    await expectRejected(
      build(),
      bearer(await issueToken(idp, { claims: { oid: 'has space/and slash' } })),
      'malformed_token',
    );
  });

  it('[NFR-SEC-02] answers 403 when no claimed role maps to a CaseGuard role', async () => {
    for (const roles of [[], ['Unmapped.Role'], 'CaseGuard.Administrator', undefined, 7]) {
      const token = await issueToken(idp, { claims: { roles: roles as never } });
      const error = await failureOf(build().authenticate(bearer(token)));
      expect(error, JSON.stringify(roles)).toBeInstanceOf(AuthorizationError);
      expect((error as AuthorizationError).status).toBe(403);
    }
  });

  it('only maps roles by exact (case-sensitive) value', async () => {
    const token = await issueToken(idp, { claims: { roles: ['caseguard.administrator'] } });
    await expect(build().authenticate(bearer(token))).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('inspects a bounded number of role claims', async () => {
    const roles = [
      ...Array.from({ length: 300 }, (_, i) => `Noise.${i}`),
      'CaseGuard.Administrator',
    ];
    const token = await issueToken(idp, { claims: { roles } });
    await expect(build().authenticate(bearer(token))).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe('EntraJwtAuthenticator: Authorization header handling', () => {
  it('rejects missing, blank and non-Bearer credentials', async () => {
    const authenticator = build();
    await expectRejected(authenticator, {}, 'missing_credentials');
    await expectRejected(authenticator, { authorization: '   ' }, 'missing_credentials');
    await expectRejected(
      authenticator,
      { authorization: 'Basic dXNlcjpwYXNz' },
      'malformed_credentials',
    );
    await expectRejected(authenticator, { authorization: 'Bearer' }, 'malformed_credentials');
    await expectRejected(authenticator, { authorization: 'Bearer a b' }, 'malformed_credentials');
    await expectRejected(
      authenticator,
      { authorization: 'Bearer <script>' },
      'malformed_credentials',
    );
  });

  it('rejects repeated Authorization headers instead of picking one', async () => {
    const token = await issueToken(idp);
    await expectRejected(
      build(),
      { authorization: [`Bearer ${token}`, `Bearer ${token}`] },
      'malformed_credentials',
    );
  });

  it('rejects oversized bearer values before parsing them', async () => {
    const huge = `Bearer ${'a'.repeat(20_000)}`;
    await expectRejected(build(), { authorization: huge }, 'malformed_credentials');
    await expectRejected(
      build({ maxTokenLength: 64 }),
      bearer(await issueToken(idp)),
      'malformed_credentials',
    );
  });
});

describe('EntraJwtAuthenticator: user resolution hook', () => {
  it('lets the platform map the identity to a stored user without changing roles', async () => {
    const resolveUser = vi.fn(async (_claims: VerifiedEntraClaims) => ({
      userId: 'user_ava_engineer',
      displayName: 'Ava (provisioned)',
      email: null,
      synthetic: true,
    }));
    const context = await build({ resolveUser }).authenticate(bearer(await issueToken(idp)));
    expect(context).toMatchObject({
      userId: 'user_ava_engineer',
      subject: OID,
      displayName: 'Ava (provisioned)',
      email: null,
      synthetic: true,
      roles: ['engineer'],
    });
    const claims = resolveUser.mock.calls[0]?.[0];
    expect(claims).toMatchObject({
      entraTenantId: TENANT_A,
      tenantId: 'tenant_contoso_support',
      objectId: OID,
    });
  });

  it('[NFR-SEC-02] rejects unknown and disabled users', async () => {
    const token = bearer(await issueToken(idp));
    await expectRejected(build({ resolveUser: async () => null }), token, 'unknown_user');
    await expectRejected(
      build({ resolveUser: async () => ({ userId: 'user_x', disabled: true }) }),
      token,
      'user_disabled',
    );
  });

  it('does not call the hook for tokens that failed validation', async () => {
    const resolveUser = vi.fn(async (_claims: VerifiedEntraClaims) => ({ userId: 'user_x' }));
    const token = await issueToken(idp, { audience: 'api://nope' });
    await failureOf(build({ resolveUser }).authenticate(bearer(token)));
    expect(resolveUser).not.toHaveBeenCalled();
  });
});

describe('EntraJwtAuthenticator: key retrieval failures', () => {
  it('reports an unreachable identity provider as 503, not as a bad credential', async () => {
    const authenticator = build({
      keyResolver: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const error = await failureOf(authenticator.authenticate(bearer(await issueToken(idp))));
    expect(error).toBeInstanceOf(IdentityProviderUnavailableError);
    expect((error as IdentityProviderUnavailableError).status).toBe(503);

    const timeout = build({
      keyResolver: async () => {
        throw new joseErrors.JWKSTimeout();
      },
    });
    await expect(timeout.authenticate(bearer(await issueToken(idp)))).rejects.toBeInstanceOf(
      IdentityProviderUnavailableError,
    );
  });
});

describe('EntraJwtAuthenticator: configuration is validated up front', () => {
  it('fails fast on unsafe or incomplete options', () => {
    const bad: Partial<EntraJwtAuthenticatorOptions>[] = [
      { issuer: [] },
      { issuer: '' },
      { audience: [] },
      { keyResolver: undefined }, // no resolver and no jwksUri
      { keyResolver: undefined, jwksUri: 'not a url' },
      { keyResolver: undefined, jwksUri: 'http://login.example.test/keys' },
      { algorithms: [] },
      { algorithms: ['none'] },
      { algorithms: ['HS256'] },
      { algorithms: ['RS256', 'HS512'] },
      { clockToleranceSeconds: -1 },
      { clockToleranceSeconds: 301 },
      { clockToleranceSeconds: Number.NaN },
    ];
    for (const overrides of bad) {
      expect(() => build(overrides), JSON.stringify(overrides)).toThrow(AuthConfigurationError);
    }
  });
});

describe('EntraJwtAuthenticator: remote JWKS (loopback server, no external network)', () => {
  let server: Server;
  let jwksUri: string;
  let healthy = true;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (!healthy || request.url !== '/keys') {
        response.writeHead(500).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(idp.jwks));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    jwksUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/keys`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('validates tokens using the default remote key set', async () => {
    const authenticator = build({ keyResolver: undefined, jwksUri, allowInsecureJwksUri: true });
    const context = await authenticator.authenticate(bearer(await issueToken(idp)));
    expect(context.userId).toBe(OID);
  });

  it('turns a failing key endpoint into a 503', async () => {
    healthy = false;
    const authenticator = build({ keyResolver: undefined, jwksUri, allowInsecureJwksUri: true });
    await expect(authenticator.authenticate(bearer(await issueToken(idp)))).rejects.toBeInstanceOf(
      IdentityProviderUnavailableError,
    );
    healthy = true;
  });
});
