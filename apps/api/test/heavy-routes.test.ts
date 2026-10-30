import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROUTES, type RouteId, type RouteSpec } from '@caseguard/schemas';
import { ConflictError } from '../src/errors';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import { HEAVY_ROUTES, type HandlerMap } from '../src/http/route-binder';
import { PERSONAS, createHarness, openSharedDatabase, type Harness } from './support/app-harness';

/*
 * The stricter per-user limit is the only thing between a signed-in user and the expensive paths
 * (the whole ingestion pipeline, the analysis engine, model calls, exports). A route that does that
 * work but is missing from HEAVY_ROUTES is limited only by the general per-IP allowance.
 */

const routeIds = Object.keys(ROUTES) as RouteId[];

describe('the heavy-route table', () => {
  it('lists every route that runs the ingestion pipeline, an upload or a background job', () => {
    const expected: RouteId[] = [
      'ingestion.preview',
      'ingestion.previewFile',
      'cases.create',
      'cases.createFromFile',
      'analysis.start',
      'counterfactuals.run',
      'skills.extract',
      'skills.simulationTest',
      'skills.proposeMutation',
      'skills.apply',
      'skillMatches.apply',
      'governance.export',
      'governance.auditVerify',
      'demo.seed',
    ];
    for (const id of expected) expect(HEAVY_ROUTES.has(id), id).toBe(true);
  });

  it('covers every upload route and every route that answers 202 (work queued in the background)', () => {
    const missing = routeIds.filter((id) => {
      const spec: RouteSpec = ROUTES[id];
      return (spec.multipart === true || spec.status === 202) && !HEAVY_ROUTES.has(id);
    });
    expect(missing).toEqual([]);
  });

  it('covers every ingestion route', () => {
    const missing = routeIds.filter((id) => id.startsWith('ingestion.') && !HEAVY_ROUTES.has(id));
    expect(missing).toEqual([]);
  });

  it('never lists a route that does not exist', () => {
    for (const id of HEAVY_ROUTES) expect(routeIds).toContain(id);
  });
});

describe('the limit on the preview routes', () => {
  let database: Database;
  let h: Harness;

  beforeAll(async () => {
    database = await openSharedDatabase();
    const handlers: HandlerMap = {
      'ingestion.preview': async () => {
        throw new ConflictError('stub: the limiter runs before the handler');
      },
    };
    h = await createHarness({
      database,
      handlers,
      env: { RATE_LIMIT_AI_MAX: '2', RATE_LIMIT_WINDOW_MS: '60000' },
    });
  }, TEST_DATABASE_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    await h.close();
    await database.close();
  });

  it('refuses a third preview of the window from one user, and counts users separately', async () => {
    const preview = (persona: string) =>
      h.call(persona, {
        method: 'POST',
        url: '/api/v1/ingestion/preview',
        payload: { source: { type: 'sample', sampleId: 'case-one' } },
      });
    expect((await preview(PERSONAS.engineer)).statusCode).toBe(409);
    expect((await preview(PERSONAS.engineer)).statusCode).toBe(409);
    const refused = await preview(PERSONAS.engineer);
    expect(refused.statusCode).toBe(429);
    expect(refused.data.code).toBe('rate_limited');
    expect((await preview(PERSONAS.admin)).statusCode).toBe(409);
  });
});
