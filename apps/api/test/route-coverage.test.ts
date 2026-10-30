import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROUTES, type RouteId } from '@caseguard/schemas';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import { missingHandlers } from '../src/http/route-binder';
import { createHandlers } from '../src/routes';
import { createHarness, openSharedDatabase, type Harness } from './support/app-harness';

/*
 * The build-completeness check: every route of the contract has exactly one handler, and the server
 * registers all of them. The app is built with `requireComplete: true`, the way deployed environments
 * start, so a route without a handler fails here before it can fail in production.
 */

let database: Database;
let h: Harness;

beforeAll(async () => {
  database = await openSharedDatabase();
  h = await createHarness({ database, requireComplete: true });
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);

afterAll(async () => {
  await h.close();
  await database.close();
});

describe('[NFR-API-01] every documented route is implemented', () => {
  it('leaves no route of the contract without a handler', () => {
    expect(missingHandlers(createHandlers(h.infra))).toEqual([]);
  });

  it('has a handler for exactly the routes of the contract (none for an unknown route)', () => {
    const handled = Object.keys(createHandlers(h.infra)).sort();
    expect(handled).toEqual(Object.keys(ROUTES).sort());
  });

  it('registers every route of the contract on the server under its documented method and path', () => {
    const unregistered = (Object.entries(ROUTES) as [RouteId, (typeof ROUTES)[RouteId]][])
      .filter(([, spec]) => !h.app.hasRoute({ method: spec.method, url: spec.path }))
      .map(([id]) => id);
    expect(unregistered).toEqual([]);
  });

  it('answers a route that needs credentials with a problem, never with a 404 or 501', async () => {
    const statuses = new Set<number>();
    for (const [id, spec] of Object.entries(ROUTES)) {
      if (spec.permission === null) continue;
      const path = spec.path.replace(/:[A-Za-z]+/g, 'x');
      const res = await h.call(null, { method: spec.method, url: path });
      statuses.add(res.statusCode);
      expect(res.statusCode, `${id} ${spec.method} ${spec.path}`).toBe(401);
    }
    expect([...statuses]).toEqual([401]);
  });
});
