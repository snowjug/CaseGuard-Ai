import { rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import { runDemoCli } from '../src/services/demo/demo-cli';

/*
 * The command line behind `pnpm demo:seed` and `pnpm demo:reset` (direct mode). Every run opens its
 * own in-memory database from the environment it is given, so these tests look at what the command
 * returns and prints: exit codes, the summary, and that no connection detail or secret is shown.
 */

const OBJECTS_DIR = '.data/test-demo-cli-objects';
const ENV: NodeJS.ProcessEnv = {
  APP_ENV: 'local',
  DATABASE_URL: 'pglite://memory',
  STORAGE_LOCAL_DIR: OBJECTS_DIR,
  LOG_LEVEL: 'fatal',
};

const logSpy = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);
const errorSpy = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);
let out: ReturnType<typeof logSpy>;
let err: ReturnType<typeof errorSpy>;

const printed = (spy: { mock: { calls: unknown[][] } }): string =>
  spy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');

beforeEach(() => {
  out = logSpy();
  err = errorSpy();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await rm(OBJECTS_DIR, { recursive: true, force: true });
});

describe('[FR-DEMO-16] demo command line: usage and configuration errors', () => {
  it.each([
    ['seed', ['--profile', 'everything'], /Unknown profile/],
    ['seed', ['--profile'], /Unknown profile/],
    ['seed', ['--profile=full'], /Unknown profile/],
    ['seed', ['--', '--profile', 'everything'], /Unknown profile/],
    ['seed', ['--', '--bogus'], /Usage: pnpm demo:seed/],
    ['seed', ['--bogus'], /Usage: pnpm demo:seed/],
    ['reset', ['--profile', 'base'], /Usage: pnpm demo:reset/],
  ] as const)('%s %j exits with 2 and prints the usage, opening nothing', async (...args) => {
    const [command, argv, message] = args;
    expect(await runDemoCli(command, argv, ENV)).toBe(2);
    expect(printed(err)).toMatch(message);
    expect(printed(out)).toBe('');
  });

  it('exits with 1 on an invalid configuration, naming the variable and never a value', async () => {
    const password = 'not-a-real-password-9f3b';
    const env = {
      ...ENV,
      DATABASE_URL: `postgres://caseguard:${password}@db.example.invalid:5432/app`,
      LOG_LEVEL: 'loud',
    };
    expect(await runDemoCli('seed', [], env)).toBe(1);
    expect(printed(err)).toMatch(/Invalid configuration[\s\S]*LOG_LEVEL/);
    expect(printed(err) + printed(out)).not.toContain(password);
    expect(printed(err)).not.toContain('loud');
  });

  it('also refuses a production-shaped environment that enables demo mode, without echoing the connection string', async () => {
    const password = 'not-a-real-password-9f3b';
    const env = {
      APP_ENV: 'production',
      DEMO_MODE: 'true',
      DATABASE_URL: `postgres://caseguard:${password}@db.example.invalid:5432/app`,
    };
    expect(await runDemoCli('reset', [], env)).toBe(1);
    expect(printed(err)).toMatch(/Invalid configuration[\s\S]*DEMO_MODE/);
    expect(printed(err) + printed(out)).not.toContain(password);
    expect(printed(err)).not.toContain('db.example.invalid');
  });
});

describe('[FR-DEMO-17] demo command line: direct mode against a synthetic workspace', () => {
  it(
    'seeds the base profile as the administrator: exit 0, a short summary, no connection detail',
    async () => {
      expect(await runDemoCli('seed', ['--profile', 'base'], ENV)).toBe(0);
      const text = printed(out);
      expect(text).toContain('Demo seeded (base): 0 of 13 story steps complete.');
      expect(text).toContain('Synthetic demonstration data');
      expect(text).toMatch(/Provider: deterministic \(simulated\)\./);
      expect(text).not.toMatch(/Case One|Case Two|Skill:/);
      expect(text).not.toMatch(/pglite|DATABASE_URL|:\/\//i);
      expect(printed(err)).toBe('');
    },
    TEST_DATABASE_STARTUP_TIMEOUT_MS,
  );

  it(
    'resets a workspace back to step one: exit 0 and the same honest summary',
    async () => {
      expect(await runDemoCli('reset', [], ENV)).toBe(0);
      const text = printed(out);
      expect(text).toContain('Demo data reset: 0 of 13 story steps complete.');
      expect(text).toContain('Synthetic demonstration data');
      expect(text).not.toMatch(/pglite|DATABASE_URL|:\/\//i);
      expect(printed(err)).toBe('');
    },
    TEST_DATABASE_STARTUP_TIMEOUT_MS,
  );
});
