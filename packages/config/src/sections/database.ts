import type { BuildContext } from '../context';
import { redactSecretsInText, Secret } from '../secret';
import type { DatabaseConfig } from '../types';

const DEFAULT_LOCAL_URL = 'pglite://.data/caseguard';
const TLS_MODES: ReadonlySet<string> = new Set(['require', 'verify-ca', 'verify-full']);

interface ParsedUrl {
  kind: 'pglite' | 'postgres';
  display: string;
  hasPassword: boolean;
  tlsMode: string | null;
}

/** Classifies DATABASE_URL and builds a log-safe description. Returns null (after reporting) when invalid. */
function parseDatabaseUrl(ctx: BuildContext, text: string): ParsedUrl | null {
  if (text.startsWith('pglite://')) {
    const target = text.slice('pglite://'.length);
    if (target === '') {
      ctx.fail(
        'DATABASE_URL',
        "pglite URLs need a target: 'pglite://memory' or 'pglite://<directory>'",
      );
      return null;
    }
    return { kind: 'pglite', display: text, hasPassword: false, tlsMode: null };
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    ctx.fail('DATABASE_URL', "must be a 'postgres://' or 'pglite://' URL");
    return null;
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    ctx.fail('DATABASE_URL', "must be a 'postgres://' or 'pglite://' URL");
    return null;
  }
  const database = url.pathname.replace(/^\//, '');
  if (url.hostname === '' || database === '') {
    ctx.fail('DATABASE_URL', 'must include a host and a database name');
    return null;
  }
  const tlsMode = url.searchParams.get('sslmode');
  const user = url.username === '' ? '' : `${decodeURIComponent(url.username)}@`;
  const port = url.port === '' ? '' : `:${url.port}`;
  const tls = tlsMode === null ? '' : `?sslmode=${tlsMode}`;
  return {
    kind: 'postgres',
    display: `${url.protocol}//${user}${url.hostname}${port}/${database}${tls}`,
    hasPassword: url.password !== '',
    tlsMode,
  };
}

/**
 * Database settings. Embedded PGlite is for local work only; deployed environments must use
 * PostgreSQL over TLS, and Entra authentication means the URL carries no password at all.
 */
export function buildDatabase(ctx: BuildContext): DatabaseConfig {
  const { raw } = ctx;
  const auth = raw.DATABASE_AUTH ?? 'password';
  const text = raw.DATABASE_URL ?? (ctx.deployed ? undefined : DEFAULT_LOCAL_URL);
  const poolMax = raw.DB_POOL_MAX ?? 10;
  const autoMigrate = raw.DB_AUTO_MIGRATE ?? ctx.localLike;

  const fallback: DatabaseConfig = {
    kind: 'pglite',
    url: new Secret(DEFAULT_LOCAL_URL),
    display: DEFAULT_LOCAL_URL,
    auth,
    autoMigrate,
    poolMax,
  };
  if (text === undefined) {
    ctx.fail('DATABASE_URL', 'is required when APP_ENV is staging or production');
    return fallback;
  }
  const parsed = parseDatabaseUrl(ctx, text);
  if (!parsed) return fallback;

  if (parsed.kind === 'pglite') {
    if (ctx.deployed)
      ctx.fail(
        'DATABASE_URL',
        'embedded PGlite is for local use; use PostgreSQL when APP_ENV is staging or production',
      );
    if (auth === 'entra')
      ctx.fail('DATABASE_AUTH', "'entra' needs a PostgreSQL DATABASE_URL, not PGlite");
  } else {
    if (auth === 'entra' && parsed.hasPassword) {
      ctx.fail(
        'DATABASE_URL',
        'must not contain a password when DATABASE_AUTH=entra (an access token is used instead)',
      );
    }
    if (auth === 'password' && !parsed.hasPassword && ctx.production) {
      ctx.fail(
        'DATABASE_URL',
        'must contain credentials when DATABASE_AUTH=password in production',
      );
    }
    if (ctx.deployed && (parsed.tlsMode === null || !TLS_MODES.has(parsed.tlsMode))) {
      ctx.fail('DATABASE_URL', 'must require TLS in deployed environments (add ?sslmode=require)');
    }
  }
  if (ctx.deployed && autoMigrate) {
    ctx.warn(
      'DB_AUTO_MIGRATE is on in a deployed environment; prefer running migrations as a separate job.',
    );
  }

  return {
    kind: parsed.kind,
    url: new Secret(text),
    display: redactSecretsInText(parsed.display),
    auth,
    autoMigrate,
    poolMax,
  };
}
