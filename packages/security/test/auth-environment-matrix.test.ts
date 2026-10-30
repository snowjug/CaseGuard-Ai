import { beforeAll, describe, expect, it } from 'vitest';
import {
  AppEnvironmentSchema,
  AuthModeSchema,
  type AppEnvironment,
  type AuthMode,
} from '@caseguard/schemas';
import { AuthConfigurationError } from '../src/errors';
import {
  DEV_AUTH_ALLOWED_ENVIRONMENTS,
  PRODUCTION_LIKE_ENVIRONMENTS,
  DevPersonaAuthenticator,
  EntraJwtAuthenticator,
  createAuthenticator,
  isDevAuthAllowedEnvironment,
} from '../src/auth';
import { AUDIENCE, TENANT_A, createTestIdp, type TestIdp } from './helpers/entra';

/**
 * SEC-1: persona login (the forgeable `x-cg-persona` header) exists only when APP_ENV is `local` or
 * `test`. `development` is the name of the internet-facing Azure development environment, so it is
 * refused like staging and production. These tables spell the rule out once, independently of the
 * implementation, and run it over every environment x mode x switch combination.
 */
const ENVIRONMENTS = AppEnvironmentSchema.options;
const MODES = AuthModeSchema.options;
const SWITCH_VALUES = [true, false] as const;

type Outcome = 'dev' | 'entra' | 'refused';

function personaAllowed(environment: string): boolean {
  return environment === 'local' || environment === 'test';
}

function expectedOutcome(environment: string, mode: AuthMode, devAuthEnabled: boolean): Outcome {
  if (mode === 'dev') return personaAllowed(environment) && devAuthEnabled ? 'dev' : 'refused';
  return !personaAllowed(environment) && devAuthEnabled ? 'refused' : 'entra';
}

const KNOWN_MATRIX = ENVIRONMENTS.flatMap((environment) =>
  MODES.flatMap((mode) =>
    SWITCH_VALUES.map((devAuthEnabled) => ({
      environment,
      mode,
      devAuthEnabled,
      outcome: expectedOutcome(environment, mode, devAuthEnabled),
    })),
  ),
);

/** Names that are not environments: typos, case variants, padding, and the usual aliases. */
const UNKNOWN_ENVIRONMENTS = [
  'prod',
  'dev',
  'Local',
  'LOCAL',
  'TEST',
  'Development',
  ' local',
  'local ',
  'test\n',
  'localhost',
  '',
];

const UNKNOWN_MATRIX = UNKNOWN_ENVIRONMENTS.flatMap((environment) =>
  MODES.flatMap((mode) =>
    SWITCH_VALUES.map((devAuthEnabled) => ({
      environment,
      mode,
      devAuthEnabled,
      outcome: expectedOutcome(environment, mode, devAuthEnabled),
    })),
  ),
);

const lookupPersona = async () => null;
const entraOptions = {
  tenantId: TENANT_A,
  audience: AUDIENCE,
  issuer: null,
  jwksUri: null,
  tenantMap: { [TENANT_A]: 'tenant_contoso_support' },
  roleMap: { 'CaseGuard.Engineer': 'engineer' as const },
};

let idp: TestIdp;
beforeAll(async () => {
  idp = await createTestIdp();
});

function build(environment: string, mode: AuthMode, devAuthEnabled: boolean) {
  return () =>
    createAuthenticator(
      { mode, environment: environment as AppEnvironment, devAuthEnabled, entra: entraOptions },
      { lookupPersona, keyResolver: idp.keyResolver },
    );
}

describe('[SEC-1] the persona-login environment allow-list', () => {
  it('is exactly local and test, and cannot be changed at runtime', () => {
    expect([...DEV_AUTH_ALLOWED_ENVIRONMENTS]).toEqual(['local', 'test']);
    expect(DEV_AUTH_ALLOWED_ENVIRONMENTS).not.toContain('development');
    expect(Object.isFrozen(DEV_AUTH_ALLOWED_ENVIRONMENTS)).toBe(true);
    expect(Object.isFrozen(PRODUCTION_LIKE_ENVIRONMENTS)).toBe(true);
  });

  it('knows every APP_ENV value, so a new environment must be added to these tables on purpose', () => {
    expect([...ENVIRONMENTS].sort()).toEqual([
      'development',
      'local',
      'production',
      'staging',
      'test',
    ]);
  });

  it.each(ENVIRONMENTS.map((environment) => [environment, personaAllowed(environment)] as const))(
    'isDevAuthAllowedEnvironment(%s) is %s',
    (environment, allowed) => {
      expect(isDevAuthAllowedEnvironment(environment)).toBe(allowed);
    },
  );

  it.each(UNKNOWN_ENVIRONMENTS.map((environment) => [JSON.stringify(environment), environment]))(
    'isDevAuthAllowedEnvironment refuses the unknown name %s',
    (_label, environment) => {
      expect(isDevAuthAllowedEnvironment(environment)).toBe(false);
    },
  );
});

describe('[SEC-1] createAuthenticator over every APP_ENV x AUTH_MODE x DEV_AUTH_ENABLED', () => {
  it('has a table row for each of the 20 combinations', () => {
    expect(KNOWN_MATRIX).toHaveLength(ENVIRONMENTS.length * MODES.length * SWITCH_VALUES.length);
    const personaRows = KNOWN_MATRIX.filter((row) => row.outcome === 'dev');
    expect(personaRows.map((row) => row.environment).sort()).toEqual(['local', 'test']);
  });

  it.each(KNOWN_MATRIX)(
    'APP_ENV=$environment AUTH_MODE=$mode DEV_AUTH_ENABLED=$devAuthEnabled -> $outcome',
    ({ environment, mode, devAuthEnabled, outcome }) => {
      const attempt = build(environment, mode, devAuthEnabled);
      if (outcome === 'refused') {
        expect(attempt).toThrow(AuthConfigurationError);
        return;
      }
      expect(attempt()).toBeInstanceOf(
        outcome === 'dev' ? DevPersonaAuthenticator : EntraJwtAuthenticator,
      );
    },
  );

  it.each(UNKNOWN_MATRIX)(
    'unknown APP_ENV=$environment AUTH_MODE=$mode DEV_AUTH_ENABLED=$devAuthEnabled -> $outcome',
    ({ environment, mode, devAuthEnabled, outcome }) => {
      const attempt = build(environment, mode, devAuthEnabled);
      if (outcome === 'refused') {
        expect(attempt).toThrow(AuthConfigurationError);
        return;
      }
      // Entra validation does not depend on the environment name; only the persona switch is guarded.
      expect(outcome).toBe('entra');
      expect(attempt()).toBeInstanceOf(EntraJwtAuthenticator);
    },
  );

  it('never produces a persona authenticator outside local and test', () => {
    const personaEnvironments = [...KNOWN_MATRIX, ...UNKNOWN_MATRIX]
      .filter((row) => {
        try {
          return (
            build(row.environment, row.mode, row.devAuthEnabled)() instanceof
            DevPersonaAuthenticator
          );
        } catch {
          return false;
        }
      })
      .map((row) => row.environment);
    expect(new Set(personaEnvironments)).toEqual(new Set(['local', 'test']));
  });
});

describe('[SEC-1] DevPersonaAuthenticator construction over every environment x allowDev', () => {
  const ALLOW_DEV_VALUES: readonly unknown[] = [true, false, undefined, null, 'true', 1];

  it.each(
    ENVIRONMENTS.flatMap((environment) =>
      ALLOW_DEV_VALUES.map((allowDev) => [environment, allowDev] as const),
    ),
  )('APP_ENV=%s allowDev=%o', (environment, allowDev) => {
    const construct = () =>
      new DevPersonaAuthenticator({
        allowDev: allowDev as boolean,
        environment,
        lookupPersona,
      });
    if (allowDev === true && personaAllowed(environment)) {
      expect(construct).not.toThrow();
    } else {
      expect(construct).toThrow(AuthConfigurationError);
    }
  });
});
