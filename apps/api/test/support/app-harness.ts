import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { LightMyRequestResponse } from 'fastify';
import { loadConfig, type AppConfig } from '@caseguard/config';
import { buildApp } from '../../src/app';
import { createInfrastructure, type Container } from '../../src/container';
import { createTestDatabase, TestClock, createSequentialIdGenerator } from '../../src/db/testing';
import type { Database, TenantRepositories } from '../../src/db';
import type { IdGenerator } from '../../src/db/ids';
import type { HandlerMap } from '../../src/http/route-binder';
import { createHandlers } from '../../src/routes';
import type { Services } from '../../src/services/ports';

export const PERSONAS = {
  engineer: 'user_ava_engineer',
  reviewer: 'user_riley_reviewer',
  manager: 'user_morgan_manager',
  curator: 'user_casey_curator',
  admin: 'user_alex_admin',
  otherTenantEngineer: 'user_fabi_engineer',
} as const;

export const CONTOSO = 'tenant_contoso_support';
export const FABRIKAM = 'tenant_fabrikam_lab';

export interface HarnessOptions {
  /** Environment overrides on top of the test defaults. */
  readonly env?: Record<string, string>;
  /** Replaces the real handlers; omit to use the application's own. */
  readonly handlers?: HandlerMap;
  /** Defaults to false so a partial build can still be exercised. */
  readonly requireComplete?: boolean;
  /** Reuse a database across harnesses of one test file (starting PGlite is slow). */
  readonly database?: Database;
  /** Replaces individual services (for example a fake `analysis` port in ingestion tests). */
  readonly services?: Partial<Services>;
  /** Replaces the process-wide sequential id source, for example with ids shaped like production ones. */
  readonly newId?: IdGenerator;
}

/** Parsed response bodies are asserted on freely in tests, so they are deliberately loosely typed. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export interface ApiResponse extends LightMyRequestResponse {
  /** Parsed JSON body (`application/json` or `application/problem+json`). */
  readonly data: Json;
}

export interface Harness {
  readonly app: FastifyInstance;
  readonly infra: Container;
  readonly config: AppConfig;
  readonly clock: TestClock;
  /** Every JSON log line written so far, parsed. */
  logs(): Record<string, unknown>[];
  /** Sends a request as a persona (or anonymously with `null`). */
  call(persona: string | null, options: InjectOptions): Promise<ApiResponse>;
  /** Repositories for a tenant, for assertions on what was persisted. */
  repos(tenantId: string, actorId?: string): TenantRepositories;
  close(): Promise<void>;
}

/** Opens one database for a whole test file. */
export async function openSharedDatabase(): Promise<Database> {
  return createTestDatabase();
}

/**
 * One id source per test process: harnesses in a file share one database, so each must keep minting
 * ids that the previous ones have not used.
 */
const sharedIds = createSequentialIdGenerator();

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const storageDir = mkdtempSync(join(tmpdir(), 'caseguard-api-test-'));
  const config = loadConfig({
    APP_ENV: 'test',
    DATABASE_URL: 'pglite://memory',
    STORAGE_LOCAL_DIR: storageDir,
    LOG_LEVEL: 'debug',
    RATE_LIMIT_MAX: '100000',
    RATE_LIMIT_AI_MAX: '100000',
    ...options.env,
  });

  const clock = new TestClock('2026-01-15T09:00:00.000Z', 0);
  const lines: string[] = [];
  const ownsDatabase = options.database === undefined;
  const database = options.database ?? (await createTestDatabase());
  const infra = await createInfrastructure(config, {
    database,
    now: clock.now,
    newId: options.newId ?? sharedIds,
    ...(options.services ? { services: options.services } : {}),
    logDestination: { write: (chunk: string) => void lines.push(chunk) },
  });
  const app = await buildApp({
    infra,
    handlers: options.handlers ?? createHandlers(infra),
    requireComplete: options.requireComplete ?? false,
  });

  return {
    app,
    infra,
    config,
    clock,
    logs: () =>
      lines
        .flatMap((chunk) => chunk.split('\n'))
        .filter((line) => line.trim().startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    async call(persona, request) {
      const headers: Record<string, string> = { ...(request.headers as Record<string, string>) };
      if (persona !== null) headers['x-cg-persona'] = persona;
      const response = await app.inject({ ...request, headers });
      const contentType = String(response.headers['content-type'] ?? '');
      const data: unknown =
        contentType.includes('json') && response.body.length > 0
          ? JSON.parse(response.body)
          : undefined;
      return Object.assign(response, { data });
    },
    repos: (tenantId, actorId = 'system:test') => infra.repos.forTenant({ tenantId, actorId }),
    async close() {
      await app.close();
      await infra.services.jobs.idle();
      if (ownsDatabase) await database.close();
      rmSync(storageDir, { recursive: true, force: true });
    },
  };
}
