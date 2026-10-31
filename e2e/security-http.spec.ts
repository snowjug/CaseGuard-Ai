import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expect, test } from './support/fixtures';
import {
  Api,
  anonymous,
  asPersona,
  listCases,
  waitForJob,
  type ApiResponse,
  type Job,
} from './support/api';
import { API_ORIGIN, ROOT, WEB_ORIGIN } from './support/env';
import { startEchoServer, type EchoServer, type EchoedRequest } from './support/echo-server';
import { deleteCase } from './support/flows';
import { headerCount, rawRequest } from './support/raw-http';
import {
  startApiExpectingRefusal,
  startApiInstance,
  startWebInstance,
  type RunningApi,
  type RunningWeb,
} from './support/servers';
import { PERSONAS, type PersonaKey } from './support/personas';

/** The nonce of a Content-Security-Policy header value, or null. */
const nonceOf = (csp: string | undefined): string | null =>
  /'nonce-([^']+)'/.exec(csp ?? '')?.[1] ?? null;

interface SampleBundle {
  schemaVersion: unknown;
  synthetic: boolean;
  syntheticNotice?: string;
  case: Record<string, unknown>;
  participants: unknown[];
  events: Record<string, unknown>[];
}

/**
 * A small synthetic case bundle under its own reference: `eventCount` engineer notes one minute apart. Its views have
 * never been computed, which is what the metered earlier views need. It takes the header fields from the real sample,
 * so it stays valid when the bundle schema version moves.
 */
function syntheticBundle(reference: string, eventCount: number): SampleBundle {
  const sample = JSON.parse(
    readFileSync(
      path.join(ROOT, 'synthetic-data', 'cases', 'case-two-teams-signin-proxy.json'),
      'utf8',
    ),
  ) as SampleBundle;
  const opened = Date.parse('2026-05-04T08:00:00Z');
  return {
    schemaVersion: sample.schemaVersion,
    synthetic: true,
    syntheticNotice: 'Synthetic case written by the end-to-end suite.',
    case: {
      ...sample.case,
      reference,
      title: `End-to-end case ${reference}`,
      status: 'open',
      openedAt: new Date(opened).toISOString().replace('.000Z', 'Z'),
      closedAt: undefined,
      tags: ['synthetic', 'e2e'],
    },
    participants: [{ id: 'p-eng', role: 'support_engineer', alias: 'Support Engineer 1' }],
    events: Array.from({ length: eventCount }, (_unused, index) => ({
      id: `n${String(index + 1).padStart(3, '0')}`,
      timestamp: new Date(opened + index * 60_000).toISOString().replace('.000Z', 'Z'),
      participantId: 'p-eng',
      type: 'case_note',
      channel: 'internal',
      title: `Note ${index + 1}`,
      body: `Synthetic note ${index + 1}: checked the sign-in log for the affected users.`,
    })),
  };
}

test.describe('[NFR-SEC-04] security headers and the nonce CSP (black box)', () => {
  test('a page carries a per-request nonce CSP, and every script in it uses that nonce', async ({
    request,
  }) => {
    const first = await request.get('/');
    const second = await request.get('/');
    expect(first.status()).toBe(200);
    const csp = first.headers()['content-security-policy'];
    expect(csp, 'the page has a Content-Security-Policy').toBeTruthy();

    const directives = Object.fromEntries(
      csp!.split(';').map((entry) => {
        const [name, ...values] = entry.trim().split(/\s+/);
        return [name, values.join(' ')];
      }),
    );
    expect(directives['default-src']).toBe("'self'");
    expect(directives['script-src']).toMatch(/^'self' 'nonce-[^']+' 'strict-dynamic'$/);
    expect(directives['script-src']).not.toContain('unsafe-eval');
    expect(directives['script-src']).not.toContain('unsafe-inline');
    expect(directives['frame-ancestors']).toBe("'none'");
    expect(directives['object-src']).toBe("'none'");
    expect(directives['base-uri']).toBe("'self'");
    expect(directives['form-action']).toBe("'self'");
    expect(directives['connect-src']).toBe("'self'");
    // A plain-http run must not upgrade every sub-resource to https, or the page would stay blank.
    expect(csp).not.toContain('upgrade-insecure-requests');

    const nonce = nonceOf(csp);
    expect(nonce).toBeTruthy();
    expect(
      nonceOf(second.headers()['content-security-policy']),
      'a new nonce for every request',
    ).not.toBe(nonce);

    const html = await first.text();
    const scriptTags = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scriptTags.length).toBeGreaterThan(0);
    for (const tag of scriptTags)
      expect(tag, 'every script tag carries the nonce of the policy').toContain(`nonce="${nonce}"`);
    expect(
      first.headers()['x-nonce'],
      'the nonce is not echoed to the client as a header',
    ).toBeUndefined();
  });

  test('pages, the not-found page and static assets get the browser security header set; nothing names the framework', async ({
    request,
  }) => {
    for (const route of ['/', '/cases', '/governance', '/this-page-does-not-exist']) {
      const response = await request.get(route);
      const headers = response.headers();
      expect(headers['x-content-type-options'], route).toBe('nosniff');
      expect(headers['x-frame-options'], route).toBe('DENY');
      expect(headers['referrer-policy'], route).toBe('strict-origin-when-cross-origin');
      expect(headers['cross-origin-opener-policy'], route).toBe('same-origin');
      expect(headers['permissions-policy'], route).toContain('camera=()');
      expect(headers['strict-transport-security'], `${route} (production build)`).toContain(
        'max-age=',
      );
      expect(headers['content-security-policy'], route).toContain("frame-ancestors 'none'");
      expect(headers['x-powered-by'], route).toBeUndefined();
    }
    expect((await request.get('/this-page-does-not-exist')).status()).toBe(404);
  });

  test('a page cannot be framed (clickjacking): frame-ancestors none and X-Frame-Options deny', async ({
    page,
    diagnostics,
  }) => {
    // The browser logs every refused frame as an error; here that is the point of the test.
    diagnostics.allow(/Refused to (display|frame)|violates the following Content Security Policy/i);
    // A blank page has no policy of its own, so only the framed page's headers can refuse the frame.
    await page.goto('about:blank');
    await page.evaluate((src) => {
      const frame = document.createElement('iframe');
      frame.src = src;
      document.body.append(frame);
    }, `${WEB_ORIGIN}/cases`);
    await expect
      .poll(
        () =>
          page
            .frames()
            .filter((frame) => frame !== page.mainFrame())
            .map((frame) => frame.url()),
        {
          message: 'the framed page was neither shown nor refused',
          timeout: 30_000,
        },
      )
      .toHaveLength(1);
    const [child] = page.frames().filter((frame) => frame !== page.mainFrame());
    await expect.poll(() => child?.url() ?? '', { timeout: 30_000 }).toMatch(/^chrome-error:/);
  });

  test('forwarded API responses carry no page CSP and no nonce; the API keeps its own default-src none policy', async ({
    request,
  }) => {
    const personaHeader = { 'x-cg-persona': PERSONAS.engineer.id };
    for (const route of ['/api/v1/me', '/livez', '/readyz', '/api/v1/there-is-no-such-route']) {
      const response = await request.get(route, { headers: personaHeader });
      const csp = response.headers()['content-security-policy'];
      expect(nonceOf(csp), `${route} has no nonce`).toBeNull();
      if (csp !== undefined)
        expect(csp, `${route} has the API's own policy`).toContain("default-src 'none'");
      expect(response.headers()['x-nonce'], route).toBeUndefined();
      expect(
        response.headers()['x-request-id'],
        `${route} comes back with the request id`,
      ).toBeTruthy();
    }
  });

  test('the API sets its header set on every answer, errors included, and HSTS only over https', async () => {
    const answers: ApiResponse[] = [
      await asPersona('engineer').get('/me'),
      await anonymous().get('/me'),
      await asPersona('engineer').get('/cases/case_not_there'),
      await asPersona('engineer').post('/cases', { source: { type: 'sample' } }),
    ];
    expect(answers.map((answer) => answer.status)).toEqual([200, 401, 404, 422]);
    for (const answer of answers) {
      const headers = answer.headers;
      const label = `status ${answer.status}`;
      expect(headers.get('cache-control'), label).toBe('no-store');
      expect(headers.get('x-content-type-options'), label).toBe('nosniff');
      expect(headers.get('x-frame-options'), label).toBe('DENY');
      expect(headers.get('cross-origin-resource-policy'), label).toBe('same-site');
      expect(headers.get('cross-origin-opener-policy'), label).toBe('same-origin');
      expect(headers.get('referrer-policy'), label).toBe('strict-origin-when-cross-origin');
      expect(headers.get('permissions-policy'), label).toContain('camera=()');
      expect(headers.get('x-permitted-cross-domain-policies'), label).toBe('none');
      expect(headers.get('content-security-policy'), label).toContain("default-src 'none'");
      expect(headers.get('strict-transport-security'), `${label}: plain http`).toBeNull();
      expect(headers.get('x-powered-by'), label).toBeNull();
    }
  });

  test('the probes answer without credentials and list names and states, never error text', async ({
    request,
  }) => {
    for (const probe of ['/livez', '/healthz']) {
      const response = await request.get(probe);
      expect(response.status(), probe).toBe(200);
    }
    const ready = await request.get('/readyz');
    expect(ready.status()).toBe(200);
    const body = (await ready.json()) as {
      ready: boolean;
      checks: { name: string; status: string }[];
    };
    expect(body.ready).toBe(true);
    expect(body.checks.map((check) => check.name).sort()).toEqual(
      ['database', 'migrations', 'model_provider', 'search', 'storage'].sort(),
    );
    expect(JSON.stringify(body)).not.toMatch(/error|stack|password|secret/i);
  });

  test('CORS is an allow-list: the web origin is allowed, another origin is not, credentials are never allowed', async () => {
    const preflight = (origin: string) =>
      fetch(`${API_ORIGIN}/api/v1/cases`, {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'x-cg-persona,content-type',
        },
      });
    const allowed = await preflight(WEB_ORIGIN);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(WEB_ORIGIN);
    expect(allowed.headers.get('access-control-allow-credentials')).toBeNull();
    const denied = await preflight('https://evil.example');
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });
});

test.describe('[NFR-SEC-01] tenant isolation: another workspace never sees the Contoso case', () => {
  test('a Fabrikam engineer gets 404 for every view of a Contoso case, exactly as for a case that does not exist', async ({
    demo,
  }) => {
    const fabrikam = asPersona('otherTenant');
    const views = [
      '',
      '/timeline',
      '/evidence',
      '/hypotheses',
      '/actions',
      '/forks',
      '/counterfactuals',
      '/graph',
      '/quality',
      '/metrics',
      '/warnings',
      '/coaching',
      '/twin',
      '/skill-matches',
      '/events/e01',
    ];
    const missing = await fabrikam.get('/cases/case_this_id_does_not_exist');
    expect(missing.status).toBe(404);
    // The wording names the id the caller asked for (their own input), so compare it with that id masked.
    const wording = (response: ApiResponse, id: string): string | undefined =>
      response.problem?.detail?.replace(id, '<id>');
    for (const view of views) {
      const foreign = await fabrikam.get(`/cases/${demo.caseOneId}${view}`);
      expect(foreign.status, `GET /cases/<Contoso case>${view} as Fabrikam`).toBe(404);
      expect(foreign.problem?.code).toBe('not_found');
      // Not even the wording tells a foreign case from one that never existed.
      expect(foreign.problem?.title).toBe(missing.problem?.title);
      expect(wording(foreign, demo.caseOneId)).toBe(
        wording(missing, 'case_this_id_does_not_exist'),
      );
    }
  });

  test('lists, search, jobs, skills and the demo state of the other workspace show nothing of Contoso', async ({
    demo,
  }) => {
    const fabrikam = asPersona('otherTenant');
    expect((await listCases(fabrikam)).length).toBe(0);
    expect((await listCases(asPersona('engineer'))).length).toBeGreaterThanOrEqual(2);

    const skill = await fabrikam.get(`/skills/${demo.skillId}`);
    expect(skill.status).toBe(404);
    expect((await fabrikam.get('/skills')).body).toMatchObject({ items: [] });

    const contosoJobs = await asPersona('engineer').get<{ items: Job[] }>('/jobs', {
      query: { limit: 5 },
    });
    const someJob = contosoJobs.body.items[0];
    expect(someJob, 'the seeded story ran at least one job').toBeTruthy();
    expect((await fabrikam.get(`/jobs/${someJob!.id}`)).status).toBe(404);

    const search = await fabrikam.get<{ items: unknown[] }>('/search', { query: { q: 'Teams' } });
    expect(search.status).toBe(200);
    expect(search.body.items).toEqual([]);

    const state = await fabrikam.getOk<{
      steps: { completed: boolean }[];
      caseOneId: string | null;
    }>('/demo/state');
    expect(state.steps.filter((step) => step.completed)).toHaveLength(0);
    expect(state.caseOneId).toBeNull();
  });

  test('a Fabrikam user cannot write to a Contoso case either', async ({ demo }) => {
    const fabrikam = asPersona('otherTenant');
    const analysis = await fabrikam.post(`/cases/${demo.caseOneId}/analysis`, { force: true });
    expect([403, 404]).toContain(analysis.status);
    expect((await fabrikam.delete(`/cases/${demo.caseOneId}`)).status).toBeGreaterThanOrEqual(403);
    // The case is still there for its own workspace.
    expect((await asPersona('engineer').get(`/cases/${demo.caseOneId}`)).status).toBe(200);
  });
});

test.describe('[NFR-SEC-02] roles: deny by default, and a refused action changes nothing', () => {
  test('without a credential, or with an unknown persona, every route answers 401 with a challenge', async () => {
    for (const client of [anonymous(), new Api(null)]) {
      const response = await client.get('/cases');
      expect(response.status).toBe(401);
      expect(response.problem?.code).toBe('unauthenticated');
      expect(response.headers.get('www-authenticate')).toMatch(/bearer/i);
    }
    const unknown = await fetch(`${API_ORIGIN}/api/v1/cases`, {
      headers: { 'x-cg-persona': 'user_nobody' },
    });
    expect(unknown.status).toBe(401);
  });

  test('an engineer and a manager cannot delete a case, an administrator-only action; the case survives', async ({
    demo,
  }) => {
    for (const persona of ['engineer', 'manager'] as const) {
      const refused = await asPersona(persona).delete(`/cases/${demo.caseOneId}`);
      expect(refused.status, persona).toBe(403);
      expect(refused.problem?.code).toBe('forbidden');
      expect(refused.requestId).toBeTruthy();
    }
    expect((await asPersona('manager').get(`/cases/${demo.caseOneId}`)).status).toBe(200);
  });

  test('engineers, reviewers and managers cannot publish or approve a skill; a refusal is 403 forbidden or a named conflict', async ({
    demo,
  }) => {
    const skill = await asPersona('admin').getOk<{
      skill: { version: number };
      currentVersion: { id: string };
    }>(`/skills/${demo.skillId}`);
    const publish = {
      toState: 'published',
      reason: 'e2e probe: must be refused',
      expectedVersion: skill.skill.version,
    };
    for (const persona of ['engineer', 'manager'] as const) {
      const refused = await asPersona(persona).post(`/skills/${demo.skillId}/transition`, publish);
      expect(refused.status, `${persona} publishing`).toBe(403);
      expect(refused.problem?.code).toBe('forbidden');
    }
    for (const persona of ['engineer', 'reviewer', 'manager'] as const) {
      const refused = await asPersona(persona).post(
        `/skills/${demo.skillId}/versions/${skill.currentVersion.id}/decision`,
        {
          decision: 'approved',
          reason: 'e2e probe: must be refused',
          expectedVersion: skill.skill.version,
        },
      );
      expect(refused.status, `${persona} approving a version`).toBe(403);
      expect(refused.problem?.code).toBe('forbidden');
    }
    // A reviewer may open the route, but the lifecycle names why the move is not allowed.
    const illegal = await asPersona('reviewer').post(`/skills/${demo.skillId}/transition`, publish);
    expect(illegal.status).toBe(409);
    expect(illegal.problem).toMatchObject({ code: 'conflict', reason: 'illegal_transition' });
    // Nothing changed: the skill is still at the version it had.
    const after = await asPersona('admin').getOk<{ skill: { version: number } }>(
      `/skills/${demo.skillId}`,
    );
    expect(after.skill.version).toBe(skill.skill.version);
  });

  test('administration, the audit log and demo reset are closed to roles without the permission', async () => {
    for (const persona of ['engineer', 'manager'] as const) {
      expect((await asPersona(persona).get('/audit')).status, `${persona} audit`).toBe(403);
      expect(
        (
          await asPersona(persona).put('/governance/settings/model', {
            value: {},
            expectedVersion: 1,
            changeNote: 'e2e probe',
          })
        ).status,
      ).toBe(403);
    }
    for (const persona of ['engineer', 'reviewer', 'manager', 'curator'] as const) {
      expect((await asPersona(persona).post('/demo/reset')).status, `${persona} demo.reset`).toBe(
        403,
      );
      expect(
        (await asPersona(persona).post('/demo/seed', { profile: 'portfolio' })).status,
        `${persona} demo.seed`,
      ).toBe(403);
    }
    expect((await asPersona('curator').get('/system/health')).status).toBe(403);
    expect((await asPersona('manager').get('/system/health')).status).toBe(200);
  });

  test('a request is checked for its credential before its body is read: a refused persona cannot probe validation', async () => {
    const refused = await asPersona('engineer').put('/governance/settings/model', {
      nonsense: true,
    });
    expect(refused.status).toBe(403);
    expect(refused.problem?.errors).toBeUndefined();
  });
});

test.describe('[NFR-SEC-04] input limits and content types', () => {
  const engineer = (): Api => asPersona('engineer');

  test('a JSON body over the 1 MiB limit is refused with 413 and a request id, through the web tier too', async () => {
    const huge = { source: { type: 'paste', text: 'a'.repeat(1_048_576 + 1_024) } };
    const direct = await engineer().post('/cases', huge);
    expect(direct.status).toBe(413);
    expect(direct.problem?.code).toBe('payload_too_large');
    expect(direct.problem?.correlationId).toBe(direct.requestId);

    const viaWeb = await fetch(`${WEB_ORIGIN}/api/v1/cases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cg-persona': PERSONAS.engineer.id },
      body: JSON.stringify(huge),
    });
    expect(viaWeb.status).toBe(413);
  });

  test('an upload over the 2 MiB limit is refused with 413 and nothing is stored', async () => {
    const before = (await listCases(engineer())).length;
    const form = new FormData();
    // Just over the limit: the server has read the whole body when it answers, so the answer always arrives.
    form.append(
      'file',
      new Blob([new Uint8Array(2 * 1024 * 1024 + 1_024).fill(0x20)], { type: 'application/json' }),
      'big.json',
    );
    const response = await fetch(`${API_ORIGIN}/api/v1/cases/upload`, {
      method: 'POST',
      headers: { 'x-cg-persona': PERSONAS.engineer.id },
      body: form,
    });
    expect(response.status).toBe(413);
    expect(((await response.json()) as { code: string }).code).toBe('payload_too_large');
    expect((await listCases(engineer())).length).toBe(before);
  });

  test('the wrong content type is refused: xml is 415, plain text where JSON is required is 422, broken JSON is 400', async () => {
    const send = (type: string, body: string) =>
      fetch(`${API_ORIGIN}/api/v1/cases`, {
        method: 'POST',
        headers: { 'content-type': type, 'x-cg-persona': PERSONAS.engineer.id },
        body,
      });
    const xml = await send('application/xml', '<case/>');
    expect(xml.status).toBe(415);
    expect(((await xml.json()) as { code: string }).code).toBe('unsupported_media_type');
    const text = await send('text/plain', 'hello');
    expect(text.status).toBe(422);
    expect(((await text.json()) as { code: string }).code).toBe('validation_failed');
    const broken = await send('application/json', '{not json');
    expect(broken.status).toBe(400);
    expect(((await broken.json()) as { code: string }).code).toBe('validation_failed');
  });

  test('uploads are judged by their bytes: an executable, a web page and a binary blob named .txt are refused', async () => {
    const upload = async (name: string, bytes: Buffer, type: string) => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(bytes)], { type }), name);
      const response = await fetch(`${API_ORIGIN}/api/v1/cases/upload`, {
        method: 'POST',
        headers: { 'x-cg-persona': PERSONAS.engineer.id },
        body: form,
      });
      return {
        status: response.status,
        problem: (await response.json()) as { code: string; reason?: string },
      };
    };
    const executable = await upload(
      'evil.exe',
      Buffer.from('MZ\x90\x00\x03\x00\x00\x00'),
      'application/octet-stream',
    );
    expect(executable.status).toBe(415);
    expect(executable.problem.code).toBe('unsupported_media_type');

    const page = await upload(
      'notes.json',
      Buffer.from('<html><script>alert(1)</script></html>'),
      'application/json',
    );
    expect(page.status).toBe(422);
    expect(page.problem).toMatchObject({ code: 'unsafe_content', reason: 'file_refused' });

    const binary = await upload(
      'notes.txt',
      Buffer.from([0, 1, 2, 3, 255, 254, 0, 0]),
      'text/plain',
    );
    expect(binary.status).toBe(422);
    expect(binary.problem).toMatchObject({ code: 'unsafe_content', reason: 'file_refused' });
  });

  test('a file name that tries to climb out of the upload folder is stored as a plain base name, or refused', async () => {
    const sample = JSON.stringify(
      syntheticBundle(`CG-E2E-${Date.now().toString(36).toUpperCase()}`, 3),
    );
    const form = new FormData();
    form.append(
      'file',
      new Blob([sample], { type: 'application/json' }),
      '../../etc/passwd..\\..\\case.json',
    );
    const response = await fetch(`${API_ORIGIN}/api/v1/cases/upload`, {
      method: 'POST',
      headers: { 'x-cg-persona': PERSONAS.engineer.id },
      body: form,
    });
    const text = await response.text();
    expect(response.status, text.slice(0, 300)).toBeLessThan(500);
    if (response.status === 201) {
      const created = JSON.parse(text) as { case: { id: string } };
      const source = await asPersona('engineer').get<{ source?: { fileName: string | null } }>(
        `/cases/${created.case.id}`,
      );
      expect(JSON.stringify(source.body)).not.toMatch(/\.\.[\\/]/);
      // The upload starts an analysis, which blocks the delete until it is over: wait for it rather than leave the case.
      await deleteCase(created.case.id);
    }
  });

  test('a malformed Idempotency-Key and a malformed request id are handled, not trusted', async () => {
    const badKey = await engineer().post(
      '/cases',
      { source: { type: 'sample', sampleId: 'case-one-teams-signin-dns' } },
      { headers: { 'idempotency-key': 'short' } },
    );
    expect(badKey.status).toBe(422);
    expect(badKey.problem?.errors?.some((error) => error.path.includes('idempotency-key'))).toBe(
      true,
    );

    const generated = await engineer().get('/me', {
      headers: { 'x-request-id': 'bad id with spaces!' },
    });
    expect(generated.requestId).toMatch(/^req_[0-9A-Z]{26}$/);
    const echoed = await engineer().get('/me', { headers: { 'x-request-id': 'e2e-request-0001' } });
    expect(echoed.requestId).toBe('e2e-request-0001');
  });

  test('an error carries the request id as its correlation id, and never a stack trace or a path', async () => {
    const response = await engineer().get('/cases/case_not_there');
    expect(response.problem).toMatchObject({ status: 404, code: 'not_found' });
    expect(response.problem?.correlationId).toBe(response.requestId);
    expect(response.text).not.toMatch(/\bat\s+\S+\s+\(|node_modules|[A-Z]:\\|\/home\//);
  });
});

test.describe('[NFR-REL-01] the metered earlier views refuse politely, then recover', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(420_000);
  let caseId: string | null = null;

  test.afterAll(async () => {
    if (caseId) await deleteCase(caseId);
  });

  test('more than 30 never-visited earlier instants in a minute answer 429 engine_budget with Retry-After, and the budget refills', async () => {
    const reviewer: PersonaKey = 'reviewer';
    const api = asPersona('engineer');
    const reference = `CG-E2E-${Date.now().toString(36).toUpperCase()}`;
    const created = await api.postOk<{ case: { id: string }; analysisJob: Job | null }>('/cases', {
      source: { type: 'bundle', bundle: syntheticBundle(reference, 150) },
    });
    caseId = created.case.id;
    if (created.analysisJob) await waitForJob(api, created.analysisJob.id);

    // The event instants of the whole-record timeline are the distinct earlier views of the case.
    const timeline = await asPersona(reviewer).getOk<{ events: { timestamp: string }[] }>(
      `/cases/${caseId}/timeline`,
      {
        query: { limit: 200 },
      },
    );
    const instants = [...new Set(timeline.events.map((event) => event.timestamp))];
    expect(instants.length).toBeGreaterThan(100);

    let refused: ApiResponse | null = null;
    let served = 0;
    const askedAt = performance.now();
    for (const asOf of instants) {
      const response = await asPersona(reviewer).get(`/cases/${caseId}/timeline`, {
        query: { asOf, limit: 1 },
      });
      if (response.status === 429) {
        refused = response;
        break;
      }
      expect(response.status, `asOf ${asOf}`).toBe(200);
      served += 1;
    }
    const askedForSeconds = (performance.now() - askedAt) / 1000;
    expect(refused, `a 429 within ${instants.length} distinct instants`).not.toBeNull();
    // A bucket of 30 units that refills one unit every two seconds. The set-up reads above may have taken a unit, so a
    // burst is "about 30": enough that a person dragging the time cursor is not refused, and never more than the bucket
    // plus what it refilled while this loop ran (how many that is depends on how fast the machine answers).
    const detail = `served ${served} instants in ${askedForSeconds.toFixed(1)} s`;
    expect(served, detail).toBeGreaterThanOrEqual(25);
    expect(served, detail).toBeLessThanOrEqual(30 + Math.ceil(askedForSeconds / 2));
    expect(served).toBeLessThan(instants.length);
    expect(refused!.problem).toMatchObject({
      status: 429,
      code: 'rate_limited',
      reason: 'engine_budget',
    });
    expect(refused!.problem?.correlationId).toBe(refused!.requestId);
    const retryAfter = Number(refused!.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(61);

    // The whole-record view is not metered and keeps working while the budget is empty.
    expect((await asPersona(reviewer).get(`/cases/${caseId}/quality`)).status).toBe(200);

    // The budget refills (one unit every two seconds): waiting for Retry-After is enough.
    await expect
      .poll(
        async () =>
          (
            await asPersona(reviewer).get(`/cases/${caseId}/quality`, {
              query: { asOf: instants.at(-2) },
            })
          ).status,
        { timeout: (retryAfter + 20) * 1_000, intervals: [1_000] },
      )
      .toBe(200);
  });
});

test.describe('[NFR-SEC-04] the client address the API rate-limits on (real production web server, echo stub as the API)', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(420_000);
  let echo: EchoServer;
  let web: RunningWeb;

  test.beforeAll(async () => {
    echo = await startEchoServer();
    web = await startWebInstance(echo.origin);
  });

  test.afterAll(async () => {
    await web?.stop();
    await echo?.close();
  });

  /** One GET through the second web server, with exactly these headers, and what the stub received. */
  async function forwardedWith(headers: Record<string, string | string[]>, route = '/api/v1/me') {
    const response = await rawRequest({ origin: web.origin, path: route, headers });
    expect(response.status, `${route} answered by the stub`).toBe(200);
    expect(response.headers['x-echo-server']).toBe('caseguard-e2e');
    return { response, seen: JSON.parse(response.body) as EchoedRequest };
  }

  test('a browser-supplied x-cg-client-ip is dropped; the API gets the right-most address of x-forwarded-for, once', async () => {
    const { seen } = await forwardedWith({
      'x-forwarded-for': '1.2.3.4, 5.6.7.8',
      'x-cg-client-ip': '9.9.9.9',
    });
    expect(seen.headers['x-cg-client-ip']).toBe('5.6.7.8');
    expect(headerCount(seen.rawHeaders, 'x-cg-client-ip')).toBe(1);

    const mixedCase = await forwardedWith({
      'x-forwarded-for': '1.2.3.4, 5.6.7.8',
      'X-CG-Client-IP': '9.9.9.9',
    });
    expect(mixedCase.seen.headers['x-cg-client-ip']).toBe('5.6.7.8');
    expect(headerCount(mixedCase.seen.rawHeaders, 'x-cg-client-ip')).toBe(1);

    const repeated = await forwardedWith({
      'x-forwarded-for': '1.2.3.4, 5.6.7.8',
      'x-cg-client-ip': ['1.1.1.1', '2.2.2.2'],
    });
    expect(repeated.seen.headers['x-cg-client-ip']).toBe('5.6.7.8');
    expect(headerCount(repeated.seen.rawHeaders, 'x-cg-client-ip')).toBe(1);
  });

  test('only the right-most entry counts, ports and brackets are stripped, repeated lines are joined first', async () => {
    const cases: [string | string[], string][] = [
      ['203.0.113.9, 198.51.100.4', '198.51.100.4'],
      ['1.1.1.1, 5.6.7.8:4433', '5.6.7.8'],
      ['1.1.1.1, [2001:db8::7]:443', '2001:db8::7'],
      ['[2001:db8::7]', '2001:db8::7'],
      ['2001:db8::7', '2001:db8::7'],
      [['1.1.1.1', '2.2.2.2, 3.3.3.3'], '3.3.3.3'],
    ];
    for (const [forwardedFor, expected] of cases) {
      const { seen } = await forwardedWith({ 'x-forwarded-for': forwardedFor });
      expect(seen.headers['x-cg-client-ip'], JSON.stringify(forwardedFor)).toBe(expected);
    }
  });

  test('nothing is set when the right-most entry is not an address, and the client copy is still removed', async () => {
    for (const bad of [
      '5.6.7.8, junk',
      'junk',
      '5.6.7.8, fe80::1%eth0',
      '1.2.3.4:99999',
      '5.6.7.8,',
    ]) {
      const { seen } = await forwardedWith({ 'x-forwarded-for': bad, 'x-cg-client-ip': '9.9.9.9' });
      expect(
        seen.headers['x-cg-client-ip'],
        `x-forwarded-for ${JSON.stringify(bad)}`,
      ).toBeUndefined();
    }
    // With no x-forwarded-for from the client at all, a spoofed value is still never believed.
    const { seen } = await forwardedWith({ 'x-cg-client-ip': '9.9.9.9' });
    expect(seen.headers['x-cg-client-ip']).not.toBe('9.9.9.9');
  });

  test('request id, idempotency key, authorization, persona, content type and the body reach the API unchanged', async () => {
    const sent = {
      accept: 'application/json, text/plain, */*',
      authorization: 'Bearer e2e-not-a-real-token',
      cookie: 'cg-theme=dark; cg-case=case_1',
      'idempotency-key': 'e2e-idempotency-key-0001',
      'x-correlation-id': 'corr-12345',
      'x-request-id': 'req-e2e-67890',
      'x-cg-persona': PERSONAS.engineer.id,
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.9, 198.51.100.4',
    };
    const payload = JSON.stringify({
      title: 'Case',
      note: 'café ✓',
      nested: { numbers: [1, 2, 3] },
    });
    const response = await rawRequest({
      origin: web.origin,
      method: 'POST',
      path: '/api/v1/cases?limit=5&asOf=2026-03-09T09%3A00%3A00Z&q=a%20b',
      headers: { ...sent, 'content-length': String(Buffer.byteLength(payload)) },
      body: payload,
    });
    const seen = JSON.parse(response.body) as EchoedRequest;
    for (const [name, value] of Object.entries(sent)) expect(seen.headers[name], name).toBe(value);
    expect(seen.method).toBe('POST');
    expect(seen.url, 'path and exact query string').toBe(
      '/api/v1/cases?limit=5&asOf=2026-03-09T09%3A00%3A00Z&q=a%20b',
    );
    expect(seen.bodyBytes).toBe(Buffer.byteLength(payload));
    expect(seen.bodySha256).toBe(createHash('sha256').update(payload).digest('hex'));
    expect(seen.headers['x-cg-client-ip']).toBe('198.51.100.4');
    expect(response.headers['x-request-id'], 'the API answer comes back with its request id').toBe(
      'req-e2e-67890',
    );
    expect(
      response.headers['content-security-policy'],
      'a forwarded answer is not a document',
    ).toBeUndefined();
    expect(
      Object.keys(response.headers).filter((name) =>
        /^x-middleware-(request|override)|^x-nextjs/i.test(name),
      ),
    ).toEqual([]);
  });

  test('every method, a chunked upload and the probes are forwarded with the address; pages are not forwarded', async () => {
    for (const method of ['DELETE', 'PATCH', 'PUT']) {
      const response = await rawRequest({
        origin: web.origin,
        method,
        path: '/api/v1/cases/case_1',
        headers: { 'x-forwarded-for': '1.1.1.1, 5.6.7.8' },
      });
      expect((JSON.parse(response.body) as EchoedRequest).headers['x-cg-client-ip'], method).toBe(
        '5.6.7.8',
      );
    }
    for (const probe of ['/livez', '/healthz', '/readyz']) {
      const { seen } = await forwardedWith({ 'x-forwarded-for': '1.1.1.1, 5.6.7.8' }, probe);
      expect(seen.url).toBe(probe);
      expect(seen.headers['x-cg-client-ip']).toBe('5.6.7.8');
    }
    const upload = Buffer.alloc(300 * 1024, 0x61);
    const chunked = await rawRequest({
      origin: web.origin,
      method: 'POST',
      path: '/api/v1/cases/upload',
      headers: {
        'content-type': 'application/octet-stream',
        'x-forwarded-for': '1.1.1.1, 5.6.7.8',
      },
      body: upload,
    });
    const seenUpload = JSON.parse(chunked.body) as EchoedRequest;
    expect(seenUpload.bodySha256).toBe(createHash('sha256').update(upload).digest('hex'));
    expect(seenUpload.headers['x-cg-client-ip']).toBe('5.6.7.8');

    const before = echo.requests.length;
    const page = await rawRequest({
      origin: web.origin,
      path: '/',
      headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8', 'x-cg-client-ip': '9.9.9.9' },
    });
    expect(page.status).toBe(200);
    expect(
      page.headers['x-echo-server'],
      'a page is rendered by Next, not forwarded',
    ).toBeUndefined();
    expect(nonceOf(page.headers['content-security-policy'] as string)).toBeTruthy();
    expect(echo.requests.length, 'the stub saw nothing of the page request').toBe(before);
  });
});

test.describe('[NFR-SEC-03] development personas exist only in local and test', () => {
  test.setTimeout(600_000);

  test('the API refuses to start in production, in staging and without a named environment, and says why', async () => {
    const refusals = await Promise.all([
      startApiExpectingRefusal({
        APP_ENV: 'production',
        AUTH_MODE: 'dev',
        DEV_AUTH_ENABLED: 'true',
      }),
      startApiExpectingRefusal({ APP_ENV: 'staging', AUTH_MODE: 'dev', DEV_AUTH_ENABLED: 'true' }),
      startApiExpectingRefusal({ NODE_ENV: 'production', APP_ENV: '' }),
    ]);
    const [production, staging, unnamed] = refusals;
    for (const refusal of [production, staging, unnamed]) {
      expect(refusal.code, refusal.stderr.slice(0, 600)).toBe(1);
    }
    expect(production.stderr).toContain('AUTH_MODE');
    expect(production.stderr).toContain('DEV_AUTH_ENABLED');
    expect(production.stderr).toMatch(/persona login exists only there/);
    expect(staging.stderr).toContain('AUTH_MODE');
    expect(unnamed.stderr).toContain('APP_ENV');
    // The refusal lists variable names and reasons, never values.
    expect(`${production.stderr}${staging.stderr}`).not.toMatch(/user_ava_engineer/);
  });

  test('with AUTH_MODE=entra the persona header is a plain 401, the personas are not offered and CORS does not name the header', async () => {
    const tenant = '11111111-1111-4111-8111-111111111111';
    let entra: RunningApi | null = null;
    try {
      entra = await startApiInstance({
        AUTH_MODE: 'entra',
        DEV_AUTH_ENABLED: 'false',
        ENTRA_TENANT_ID: tenant,
        ENTRA_AUDIENCE: 'api://caseguard-e2e',
        ENTRA_TENANT_MAP: JSON.stringify({ [tenant]: 'tenant_contoso_support' }),
      });
      const client = new Api('admin', entra.origin);
      const me = await client.get('/me');
      expect(me.status).toBe(401);
      expect(me.problem?.code).toBe('unauthenticated');
      expect(me.headers.get('www-authenticate')).toMatch(/bearer/i);

      const garbage = await anonymous(entra.origin).get('/me', {
        headers: { authorization: 'Bearer not-a-jwt' },
      });
      expect(garbage.status).toBe(401);

      const personas = await anonymous(entra.origin).get<{ enabled: boolean; items: unknown[] }>(
        '/dev/personas',
      );
      expect(personas.status).toBe(200);
      expect(personas.body.enabled).toBe(false);
      expect(personas.body.items).toEqual([]);

      const preflight = await fetch(`${entra.origin}/api/v1/me`, {
        method: 'OPTIONS',
        headers: {
          origin: 'http://localhost:3000',
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'x-cg-persona',
        },
      });
      expect(preflight.headers.get('access-control-allow-headers') ?? '').not.toContain(
        'x-cg-persona',
      );
    } finally {
      await entra?.stop();
    }
  });

  test('the shared local API does accept the persona header and names it in CORS (the contrast case)', async () => {
    const me = await asPersona('engineer').get<{ authMode: string; environment: string }>('/me');
    expect(me.body).toMatchObject({ authMode: 'dev', environment: 'local' });
    const preflight = await fetch(`${API_ORIGIN}/api/v1/me`, {
      method: 'OPTIONS',
      headers: {
        origin: `http://127.0.0.1:${process.env.PW_WEB_PORT ?? '3310'}`,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'x-cg-persona',
      },
    });
    expect(preflight.headers.get('access-control-allow-headers') ?? '').toContain('x-cg-persona');
  });
});
