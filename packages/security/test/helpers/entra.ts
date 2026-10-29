import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type JWK,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';

export const TENANT_A = '11111111-1111-4111-8111-111111111111';
export const TENANT_B = '22222222-2222-4222-8222-222222222222';
export const AUDIENCE = 'api://caseguard-test';
export const ISSUER_A = `https://login.microsoftonline.com/${TENANT_A}/v2.0`;
export const ISSUER_B = `https://login.microsoftonline.com/${TENANT_B}/v2.0`;
export const OID = '9a8b7c6d-0000-4000-8000-0123456789ab';
/** Fixed "now" (epoch seconds) so token lifetimes are deterministic. */
export const NOW_SECONDS = 1_800_000_000;
export const NOW = new Date(NOW_SECONDS * 1000);

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

export interface TestIdp {
  readonly kid: string;
  readonly alg: string;
  readonly privateKey: SigningKey;
  readonly publicJwk: JWK;
  readonly keyResolver: JWTVerifyGetKey;
  readonly jwks: JSONWebKeySet;
}

/** A local identity provider: a throw-away key pair plus its JWKS. No network involved. */
export async function createTestIdp(alg = 'RS256', kid = 'test-key-1'): Promise<TestIdp> {
  const { publicKey, privateKey } = await generateKeyPair(alg);
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' };
  const jwks: JSONWebKeySet = { keys: [publicJwk] };
  return { kid, alg, privateKey, publicJwk, keyResolver: createLocalJWKSet(jwks), jwks };
}

export interface TokenOptions {
  readonly issuer?: string;
  readonly audience?: string | string[];
  readonly claims?: JWTPayload;
  /** Seconds relative to NOW_SECONDS. */
  readonly expiresInSeconds?: number | null;
  readonly notBeforeInSeconds?: number | null;
  readonly issuedAtInSeconds?: number;
  readonly kid?: string;
  readonly alg?: string;
  readonly signWith?: SigningKey;
}

export const defaultClaims = (): JWTPayload => ({
  tid: TENANT_A,
  oid: OID,
  name: 'Ava Synthetic',
  preferred_username: 'ava@contoso.example',
  roles: ['CaseGuard.Engineer'],
});

/** Signs a token; every claim can be overridden or removed (`undefined`) to build hostile variants. */
export async function issueToken(idp: TestIdp, options: TokenOptions = {}): Promise<string> {
  const claims: JWTPayload = { ...defaultClaims(), ...options.claims };
  for (const [key, value] of Object.entries(claims)) {
    if (value === undefined) Reflect.deleteProperty(claims, key);
  }
  let jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: options.alg ?? idp.alg, kid: options.kid ?? idp.kid })
    .setIssuer(options.issuer ?? ISSUER_A)
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuedAt(NOW_SECONDS + (options.issuedAtInSeconds ?? -60));
  const notBefore = options.notBeforeInSeconds === undefined ? -60 : options.notBeforeInSeconds;
  if (notBefore !== null) jwt = jwt.setNotBefore(NOW_SECONDS + notBefore);
  const expires = options.expiresInSeconds === undefined ? 3600 : options.expiresInSeconds;
  if (expires !== null) jwt = jwt.setExpirationTime(NOW_SECONDS + expires);
  return jwt.sign(options.signWith ?? idp.privateKey);
}

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/** An unsecured JWT (`alg: none`) carrying otherwise perfectly valid claims. */
export function unsecuredToken(claims: JWTPayload = {}): string {
  const payload = {
    ...defaultClaims(),
    iss: ISSUER_A,
    aud: AUDIENCE,
    iat: NOW_SECONDS - 60,
    nbf: NOW_SECONDS - 60,
    exp: NOW_SECONDS + 3600,
    ...claims,
  };
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.`;
}

export const bearer = (token: string): { authorization: string } => ({
  authorization: `Bearer ${token}`,
});
