import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, validateConfig } from '../src';
import { PRODUCTION_ENV } from './fixtures';

/**
 * SEC-1: the persona login (AUTH_MODE=dev with DEV_AUTH_ENABLED=true, the forgeable `x-cg-persona`
 * header) exists only when APP_ENV is `local` or `test`. `development` is the name of the
 * internet-facing Azure development environment, so it is refused like staging and production.
 * The table below spells the rule out once, independently of the loader, and runs it over every
 * APP_ENV x AUTH_MODE x DEV_AUTH_ENABLED combination, including the variables left unset.
 */
const ENVIRONMENTS = ['local', 'test', 'development', 'staging', 'production'] as const;
const MODES = [undefined, 'dev', 'entra'] as const;
const SWITCHES = [undefined, 'true', 'false'] as const;

type Mode = 'dev' | 'entra';

function environmentFor(
  appEnv: string,
  authMode: string | undefined,
  devAuth: string | undefined,
): Record<string, string> {
  // PRODUCTION_ENV is a complete, valid environment for every APP_ENV; only the identity switches vary.
  const base = Object.fromEntries(
    Object.entries(PRODUCTION_ENV).filter(
      ([key]) => key !== 'AUTH_MODE' && key !== 'DEV_AUTH_ENABLED',
    ),
  );
  return {
    ...base,
    APP_ENV: appEnv,
    ...(authMode === undefined ? {} : { AUTH_MODE: authMode }),
    ...(devAuth === undefined ? {} : { DEV_AUTH_ENABLED: devAuth }),
  };
}

function effectiveMode(appEnv: string, authMode: string | undefined): Mode {
  const personaAllowed = appEnv === 'local' || appEnv === 'test';
  return (authMode as Mode | undefined) ?? (personaAllowed ? 'dev' : 'entra');
}

/** The variables the rule says must be reported, in report order. */
function expectedFailures(
  appEnv: string,
  authMode: string | undefined,
  devAuth: string | undefined,
): string[] {
  const personaAllowed = appEnv === 'local' || appEnv === 'test';
  const mode = effectiveMode(appEnv, authMode);
  const enabled = devAuth === undefined ? personaAllowed && mode === 'dev' : devAuth === 'true';
  if (!personaAllowed) {
    return [...(mode === 'dev' ? ['AUTH_MODE'] : []), ...(enabled ? ['DEV_AUTH_ENABLED'] : [])];
  }
  if (mode === 'dev' && !enabled) return ['DEV_AUTH_ENABLED'];
  if (mode === 'entra' && enabled) return ['DEV_AUTH_ENABLED'];
  return [];
}

const ROWS = ENVIRONMENTS.flatMap((appEnv) =>
  MODES.flatMap((authMode) =>
    SWITCHES.map((devAuth) => {
      const failures = expectedFailures(appEnv, authMode, devAuth);
      return {
        appEnv,
        authMode,
        devAuth,
        failures,
        label: `AUTH_MODE=${authMode ?? 'unset'} DEV_AUTH_ENABLED=${devAuth ?? 'unset'}`,
        verdict: failures.length === 0 ? 'accepted' : `refused (${failures.join(', ')})`,
      };
    }),
  ),
);

describe('[SEC-1] persona login only in local and test', () => {
  it('covers every combination (5 environments x 3 modes x 3 switch values)', () => {
    expect(ROWS).toHaveLength(45);
  });

  it.each(ROWS)('APP_ENV=$appEnv $label -> $verdict', (row) => {
    const env = environmentFor(row.appEnv, row.authMode, row.devAuth);
    const result = validateConfig(env);

    if (row.failures.length > 0) {
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.map((issue) => issue.variable)).toEqual(row.failures);
      expect(() => loadConfig(env)).toThrow(ConfigError);
      return;
    }

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mode = effectiveMode(row.appEnv, row.authMode);
    expect(result.config.auth.mode).toBe(mode);
    expect(result.config.auth.devAuthEnabled).toBe(mode === 'dev');
    // The old "development identity enabled outside local" warning is gone: it is an error now.
    expect(result.config.warnings.join('\n')).not.toMatch(/identity|persona/i);
  });

  it('never produces an active persona login outside local and test, whatever the other settings', () => {
    const active = ROWS.filter((row) => {
      const result = validateConfig(environmentFor(row.appEnv, row.authMode, row.devAuth));
      return result.ok && result.config.auth.devAuthEnabled;
    });
    expect(active.length).toBeGreaterThan(0);
    expect(new Set(active.map((row) => row.appEnv))).toEqual(new Set(['local', 'test']));
  });

  it('defaults to Entra and no persona login in every deployed environment', () => {
    for (const appEnv of ['development', 'staging', 'production']) {
      const result = validateConfig(environmentFor(appEnv, undefined, undefined));
      expect(result.ok, appEnv).toBe(true);
      if (!result.ok) continue;
      expect(result.config.auth).toMatchObject({ mode: 'entra', devAuthEnabled: false });
    }
  });

  it('keeps persona login as the default for local and test', () => {
    for (const appEnv of ['local', 'test']) {
      const result = validateConfig({ APP_ENV: appEnv });
      expect(result.ok, appEnv).toBe(true);
      if (!result.ok) continue;
      expect(result.config.auth).toMatchObject({ mode: 'dev', devAuthEnabled: true });
    }
  });

  it('refuses development identity in the development environment with a message that names the rule, not the value', () => {
    let caught: unknown;
    try {
      loadConfig(environmentFor('development', 'dev', 'true'));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const error = caught as ConfigError;
    expect(error.issues).toEqual([
      {
        variable: 'AUTH_MODE',
        message:
          "must be 'entra' unless APP_ENV is local or test (persona login exists only there)",
      },
      {
        variable: 'DEV_AUTH_ENABLED',
        message: 'must be false unless APP_ENV is local or test (persona login exists only there)',
      },
    ]);
  });

  it('reports a single problem per cause: DEV_AUTH_ENABLED with Entra in a deployed environment', () => {
    const result = validateConfig(environmentFor('production', 'entra', 'true'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.variable)).toEqual(['DEV_AUTH_ENABLED']);
  });

  it('does not suggest a fix that another rule would refuse', () => {
    // In a deployed environment the only fix is AUTH_MODE=entra; "also requires DEV_AUTH_ENABLED=true"
    // would point the operator at the other forbidden switch.
    const result = validateConfig(environmentFor('development', 'dev', 'false'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.variable)).toEqual(['AUTH_MODE']);
    expect(result.issues[0]?.message).not.toMatch(/also requires/);
  });

  it.each(['prod', 'dev', 'Local', 'LOCAL', 'Test', 'localhost', 'Development', 'live'])(
    'an unknown APP_ENV name (%s) is refused outright, so it can never enable persona login',
    (appEnv) => {
      const result = validateConfig({
        APP_ENV: appEnv,
        AUTH_MODE: 'dev',
        DEV_AUTH_ENABLED: 'true',
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.map((issue) => issue.variable)).toContain('APP_ENV');
    },
  );
});
