import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import { autoSeedDemo } from '../src/services/demo/auto-seed';
import { buildDemoState } from '../src/services/demo/state';
import type { DemoPort } from '../src/services/ports';
import {
  CONTOSO,
  PERSONAS,
  createHarness,
  openSharedDatabase,
  type Harness,
} from './support/app-harness';

/*
 * The start-up hook behind `DEMO_AUTO_SEED`: it seeds the portfolio profile as the synthetic
 * administrator, logs one line either way, and never stops the server from starting. The demo service
 * is replaced by a recorder so the hook alone is under test (the seed itself is tested over HTTP).
 */

interface SeedCall {
  readonly userId: string;
  readonly tenantId: string;
  readonly profile: string;
}

let database: Database;
let h: Harness;
const calls: SeedCall[] = [];
let failure: Error | null = null;

const recorder: DemoPort = {
  state: (ctx) => buildDemoState(ctx),
  reset: (ctx) => buildDemoState(ctx),
  seed: async (ctx, options) => {
    calls.push({
      userId: ctx.auth.userId,
      tenantId: ctx.auth.tenantId,
      profile: options.profile,
    });
    if (failure !== null) throw failure;
    return buildDemoState(ctx);
  },
};

beforeAll(async () => {
  database = await openSharedDatabase();
  h = await createHarness({ database, services: { demo: recorder } });
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);

afterAll(async () => {
  await h.close();
  await database.close();
});

let logStart = 0;

beforeEach(() => {
  calls.length = 0;
  failure = null;
  logStart = h.logs().length;
});

/** The log lines of one event written since the current test began. */
const entries = (event: string) =>
  h
    .logs()
    .slice(logStart)
    .filter((line) => line.event === event);
const setAdminStatus = (status: 'active' | 'disabled') =>
  database.query(
    "UPDATE users SET status = $3, data = jsonb_set(data, '{status}', to_jsonb($3::text)) WHERE tenant_id = $1 AND id = $2",
    [CONTOSO, PERSONAS.admin, status],
  );

describe('[FR-DEMO-18] the start-up seed', () => {
  it('seeds the portfolio profile as the synthetic administrator and logs one line', async () => {
    await autoSeedDemo(h.infra);
    expect(calls).toEqual([{ userId: PERSONAS.admin, tenantId: CONTOSO, profile: 'portfolio' }]);
    const lines = entries('demo.auto_seed');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      profile: 'portfolio',
      completedSteps: 0,
      totalSteps: 13,
    });
    expect(['info', 30]).toContain(lines[0]?.level);
    expect(entries('demo.auto_seed_failed')).toEqual([]);
  });

  it('logs an error and returns normally when the seed fails, so the server still starts', async () => {
    failure = new Error('the seed broke halfway');
    await expect(autoSeedDemo(h.infra)).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    const lines = entries('demo.auto_seed_failed');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ profile: 'portfolio' });
    expect(['error', 50]).toContain(lines[0]?.level);
    expect(JSON.stringify(lines[0])).toContain('the seed broke halfway');
    expect(entries('demo.auto_seed')).toEqual([]);
  });

  it('does not seed, and says so, when the synthetic administrator is not available', async () => {
    await setAdminStatus('disabled');
    try {
      await expect(autoSeedDemo(h.infra)).resolves.toBeUndefined();
    } finally {
      await setAdminStatus('active');
    }
    expect(calls).toEqual([]);
    const lines = entries('demo.auto_seed_failed');
    expect(lines).toHaveLength(1);
    expect(JSON.stringify(lines[0])).toContain('synthetic administrator');
  });
});
