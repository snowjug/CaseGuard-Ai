import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, loadConfig, validateConfig } from '../src';
import { PRODUCTION_ENV } from './fixtures';

/**
 * An unset APP_ENV means `local`: persona login, demo mode, PGlite and the other development
 * defaults. A production runtime must not inherit them because a variable was forgotten, so
 * NODE_ENV=production requires APP_ENV to be named explicitly. The API image sets NODE_ENV=production;
 * Bicep and docker-compose both set APP_ENV, so nothing that ships is affected.
 */
const MESSAGE =
  'must be set explicitly when NODE_ENV=production: an unset value would mean local, which enables persona login and other development defaults';

type Env = Record<string, string | undefined>;

/** Spellings that mean production (case and surrounding whitespace do not matter). */
const PRODUCTION_SPELLINGS: readonly (string | undefined)[] = [
  'production',
  'Production',
  'PRODUCTION',
  '  production  ',
];

/** Every NODE_ENV the table tries: unset, blank, the usual values, near misses and the spellings above. */
const NODE_ENVS: readonly (string | undefined)[] = [
  undefined,
  '',
  '   ',
  'development',
  'test',
  'staging',
  'prod',
  ...PRODUCTION_SPELLINGS,
];

/** APP_ENV left unset in every way an environment can leave it. */
const UNSET_APP_ENVS: readonly (readonly [label: string, env: Env])[] = [
  ['absent', {}],
  ['undefined', { APP_ENV: undefined }],
  ['empty', { APP_ENV: '' }],
  ['whitespace only', { APP_ENV: '   ' }],
  ['a tab', { APP_ENV: '\t' }],
];

const APP_ENVS = ['local', 'test', 'development', 'staging', 'production'] as const;

const show = (value: string | undefined): string =>
  value === undefined ? 'unset' : JSON.stringify(value);

const withNodeEnv = (env: Env, nodeEnv: string | undefined): Env =>
  nodeEnv === undefined ? env : { ...env, NODE_ENV: nodeEnv };

const UNSET_ROWS = NODE_ENVS.flatMap((nodeEnv) =>
  UNSET_APP_ENVS.map(([appLabel, appEnv]) => {
    const refused = PRODUCTION_SPELLINGS.includes(nodeEnv);
    return {
      nodeEnv: show(nodeEnv),
      appEnv: appLabel,
      refused,
      verdict: refused ? 'refused' : 'local by default',
      env: withNodeEnv(appEnv, nodeEnv),
    };
  }),
);

const SET_ROWS = NODE_ENVS.flatMap((nodeEnv) =>
  APP_ENVS.map((appEnv) => ({
    nodeEnv: show(nodeEnv),
    appEnv,
    // PRODUCTION_ENV is a complete, valid environment for every APP_ENV.
    env: withNodeEnv({ ...PRODUCTION_ENV, APP_ENV: appEnv }, nodeEnv),
  })),
);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('[NFR-SEC-03] NODE_ENV=production requires APP_ENV when it is unset', () => {
  it('covers every combination in the tables', () => {
    expect(UNSET_ROWS).toHaveLength(NODE_ENVS.length * UNSET_APP_ENVS.length);
    expect(SET_ROWS).toHaveLength(NODE_ENVS.length * APP_ENVS.length);
    expect(UNSET_ROWS.filter((row) => row.refused)).toHaveLength(
      PRODUCTION_SPELLINGS.length * UNSET_APP_ENVS.length,
    );
  });

  it.each(UNSET_ROWS)('NODE_ENV=$nodeEnv, APP_ENV $appEnv -> $verdict', (row) => {
    const result = validateConfig(row.env);

    if (row.refused) {
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues).toEqual([{ variable: 'APP_ENV', message: MESSAGE }]);
      expect(() => loadConfig(row.env)).toThrow(ConfigError);
      return;
    }

    // Anything else keeps the documented default: an unset APP_ENV is a local run.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.runtime).toMatchObject({
      env: 'local',
      localLike: true,
      deployed: false,
      production: false,
    });
    expect(result.config.auth).toMatchObject({ mode: 'dev', devAuthEnabled: true });
  });

  it.each(SET_ROWS)('NODE_ENV=$nodeEnv, APP_ENV=$appEnv -> accepted as named', (row) => {
    const result = validateConfig(row.env);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.runtime.env).toBe(row.appEnv);
  });
});

describe('[NFR-SEC-03] the refusal itself', () => {
  it('is a single issue naming APP_ENV, even when every other production setting is present', () => {
    const withoutAppEnv = Object.fromEntries(
      Object.entries(PRODUCTION_ENV).filter(([name]) => name !== 'APP_ENV'),
    );
    const result = validateConfig({ ...withoutAppEnv, NODE_ENV: 'production' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([{ variable: 'APP_ENV', message: MESSAGE }]);
  });

  it('is reported first, together with variables too malformed to parse', () => {
    const result = validateConfig({ NODE_ENV: 'production', API_PORT: 'abc', LOG_LEVEL: 'loud' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.variable)).toEqual([
      'APP_ENV',
      'API_PORT',
      'LOG_LEVEL',
    ]);
    expect(result.issues[0]?.message).toBe(MESSAGE);
  });

  it('is not used for an APP_ENV that is set but invalid: that is reported as invalid', () => {
    for (const appEnv of ['prod', 'Production', 'live']) {
      const result = validateConfig({ NODE_ENV: 'production', APP_ENV: appEnv });
      expect(result.ok, appEnv).toBe(false);
      if (result.ok) continue;
      expect(result.issues.map((issue) => issue.variable)).toEqual(['APP_ENV']);
      expect(result.issues[0]?.message).not.toBe(MESSAGE);
    }
  });

  it('makes loadConfig throw a ConfigError that prints the same text', () => {
    let caught: unknown;
    try {
      loadConfig({ NODE_ENV: 'production' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const error = caught as ConfigError;
    expect(error.issues).toEqual([{ variable: 'APP_ENV', message: MESSAGE }]);
    expect(error.message).toBe(`Invalid configuration (1 problem):\n  - APP_ENV: ${MESSAGE}`);
  });

  it('leaves the docker-compose stack alone: the image sets NODE_ENV=production and compose names APP_ENV=local', () => {
    const result = validateConfig({
      NODE_ENV: 'production',
      APP_ENV: 'local',
      SERVICE_NAME: 'caseguard-api',
      API_HOST: '0.0.0.0',
      API_PORT: '4000',
      LOG_LEVEL: 'info',
      CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
      AUTH_MODE: 'dev',
      DEV_AUTH_ENABLED: 'true',
      DATABASE_URL: 'pglite://memory',
      STORAGE_PROVIDER: 'local',
      SEARCH_PROVIDER: 'lexical',
      AI_PROVIDER: 'deterministic',
      DEMO_MODE: 'true',
      DEMO_AUTO_SEED: 'true',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.runtime).toMatchObject({ env: 'local', production: false });
    expect(result.config.auth.devAuthEnabled).toBe(true);
  });

  it('reads the real process environment only when none is passed', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_ENV', undefined);

    // An explicit environment is never mixed with the real one.
    expect(validateConfig({}).ok).toBe(true);

    const result = validateConfig();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]).toEqual({ variable: 'APP_ENV', message: MESSAGE });
    expect(() => loadConfig()).toThrow(ConfigError);

    vi.stubEnv('APP_ENV', 'local');
    const named = validateConfig();
    expect(named.ok || named.issues.every((issue) => issue.variable !== 'APP_ENV')).toBe(true);
  });
});
