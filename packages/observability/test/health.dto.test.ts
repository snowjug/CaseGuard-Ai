import { SystemHealthSchema } from '@caseguard/schemas';
import { describe, expect, it, vi } from 'vitest';
import {
  overallHealthStatus,
  STANDARD_HEALTH_CHECKS,
  toDependencyHealth,
  toHealthStatus,
  type HealthCheckDefinition,
} from '../src';
import { buildHealth as build, migrations, ok, provider } from './helpers/health';
import { fakeSecrets } from './helpers/secrets';

describe('error sanitisation', () => {
  const secrets = fakeSecrets();

  it.each(secrets.map((secret) => [secret.id, secret] as const))(
    '[NFR-SEC-06] [NFR-OBS-01] %s never appears in a check detail',
    async (_id, secret) => {
      const { registry } = build();
      const error = Object.assign(new Error(`connect failed: ${secret.text}`), {
        code: 'ECONNREFUSED',
      });
      error.stack = `Error: connect failed\n    at connect (${secret.text})\n    at async run (/srv/app/index.js:10:5)`;
      registry.registerStandard('database', () => Promise.reject(error));
      const report = await registry.readiness({ detail: 'full' });
      const detail = report.checks[0]?.detail ?? '';
      for (const core of secret.cores) expect(detail).not.toContain(core);
      expect(detail).toMatch(/^ECONNREFUSED: /);
      expect(detail).not.toContain('\n');
      expect(detail).not.toMatch(/\bat\b.*\(/);
      expect(detail.length).toBeLessThanOrEqual(200);
    },
  );

  it('[NFR-SEC-06] [NFR-OBS-01] scrubs reported details, hands the raw error to onCheckError and caps the length', async () => {
    const seen: [string, unknown][] = [];
    const { registry } = build({ onCheckError: (name, error) => seen.push([name, error]) });
    registry.registerStandard('database', () => Promise.reject(new Error('x'.repeat(5000))));
    registry.registerStandard('search', () => ({
      status: 'degraded',
      detail: 'using lexical fallback password=fakeHunter2Value',
    }));
    const report = await registry.readiness({ detail: 'full' });
    expect((report.checks[0]?.detail ?? '').length).toBeLessThanOrEqual(200);
    expect(report.checks[1]?.detail).toContain('lexical fallback');
    expect(report.checks[1]?.detail).not.toContain('fakeHunter2Value');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toBe('database');
    expect(seen[0]?.[1]).toBeInstanceOf(Error);
  });

  it('[NFR-SEC-06] omits every detail from the default (minimal) readiness report', async () => {
    const { registry } = build();
    registry.registerStandard('database', () =>
      Promise.reject(new Error(`secret ${fakeSecrets()[0]?.text ?? ''}`)),
    );
    const report = await registry.readiness();
    expect(JSON.stringify(report)).not.toContain('detail');
    expect(JSON.stringify(report)).not.toContain('fakeBearerToken');
  });

  it('[NFR-SEC-06] applies the injected redactor to details', async () => {
    const { registry } = build({
      redact: (text) => text.replace(/internal-host-\d+/g, '[HOST]'),
    });
    registry.registerStandard('database', () =>
      Promise.reject(new Error('cannot reach internal-host-42')),
    );
    expect((await registry.readiness({ detail: 'full' })).checks[0]?.detail).toBe(
      'cannot reach [HOST]',
    );
  });
});

describe('registration, disabled checks and standard dependencies', () => {
  it('[NFR-OBS-01] rejects duplicate and malformed names', () => {
    const { registry } = build();
    registry.registerStandard('database', ok);
    expect(() => registry.registerStandard('database', ok)).toThrow(/already registered/);
    expect(() =>
      registry.register({ name: 'Bad Name', kind: 'cache', critical: false, check: ok }),
    ).toThrow(TypeError);
    expect(registry.unregister('database')).toBe(true);
    expect(registry.unregister('database')).toBe(false);
    expect(registry.names()).toEqual([]);
  });

  it('[NFR-OBS-01] marks database and migrations as the only critical standard checks', () => {
    expect(
      Object.fromEntries(
        Object.entries(STANDARD_HEALTH_CHECKS).map(([key, value]) => [key, value.critical]),
      ),
    ).toEqual({
      database: true,
      migrations: true,
      storage: false,
      search: false,
      modelProvider: false,
      cache: false,
    });
    expect(STANDARD_HEALTH_CHECKS.modelProvider.kind).toBe('ai_provider');
  });

  it('[NFR-OBS-01] reports a disabled check without calling it or letting it affect readiness', async () => {
    const { registry } = build();
    const search = vi.fn(() => Promise.reject(new Error('should not run')));
    let on = false;
    registry.registerStandard('search', search, { enabled: () => on });
    registry.registerStandard('cache', search, { enabled: false });
    registry.registerStandard('database', ok);
    const report = await registry.readiness({ detail: 'full' });
    expect(report).toMatchObject({ status: 'up', ready: true });
    expect(report.checks.map((check) => check.status)).toEqual(['disabled', 'disabled', 'up']);
    expect(search).not.toHaveBeenCalled();
    on = true;
    expect((await registry.check('search')).status).toBe('down');
  });

  it('[NFR-OBS-01] throws for an unknown check name', async () => {
    await expect(build().registry.check('nope')).rejects.toThrow(/Unknown health check/);
  });

  it('[NFR-OBS-01] keeps check definitions independent of the registry', () => {
    const definition: HealthCheckDefinition = {
      name: 'cache',
      kind: 'cache',
      critical: false,
      check: ok,
    };
    expect(() => build().registry.register(definition)).not.toThrow();
    expect(() => build().registry.register(definition)).not.toThrow();
  });
});

describe('system health DTO', () => {
  it('[NFR-OBS-01] satisfies SystemHealthSchema and maps statuses to the contract vocabulary', async () => {
    const { registry } = build();
    registry.registerStandard('database', ok);
    registry.registerStandard('migrations', () => ({ detail: '12 applied, 0 pending' }));
    registry.registerStandard('storage', ok, { simulated: true });
    registry.registerStandard('search', () => Promise.reject(new Error('index unreachable')), {
      simulated: true,
    });
    registry.registerStandard(
      'cache',
      () => ({ status: 'degraded', detail: 'memory cache evicting' }),
      { simulated: true },
    );
    registry.registerStandard('modelProvider', ok, { enabled: false });
    const health = await registry.systemHealth({
      migrations,
      provider,
      notices: ['All data in this environment is synthetic.'],
    });
    expect(SystemHealthSchema.safeParse(health).success).toBe(true);
    expect(health).toMatchObject({
      status: 'degraded',
      service: 'caseguard-api',
      version: '1.2.3',
      commit: 'abc1234',
      environment: 'staging',
      uptimeSeconds: 125,
      checkedAt: '2026-10-29T09:14:14.599Z',
      migrations,
      provider,
    });
    expect(health.dependencies.map((d) => [d.name, d.kind, d.status, d.simulated])).toEqual([
      ['database', 'database', 'healthy', false],
      ['migrations', 'migrations', 'healthy', false],
      ['storage', 'storage', 'healthy', true],
      ['search', 'search', 'unhealthy', true],
      ['cache', 'cache', 'degraded', true],
      ['model_provider', 'ai_provider', 'disabled', false],
    ]);
    expect(health.notices[0]).toBe('All data in this environment is synthetic.');
    expect(health.notices.filter((n) => n.includes('stand-in'))).toHaveLength(3);
  });

  it('[NFR-OBS-01] reports unhealthy when a critical dependency is down, healthy when all pass, unknown when none ran', async () => {
    const down = build().registry;
    down.registerStandard('database', () => Promise.reject(new Error('down')));
    expect((await down.systemHealth({ migrations, provider })).status).toBe('unhealthy');
    const up = build().registry;
    up.registerStandard('database', ok);
    expect((await up.systemHealth({ migrations, provider })).status).toBe('healthy');
    const none = build({ commit: null }).registry;
    none.registerStandard('database', ok, { enabled: false });
    const health = await none.systemHealth({ migrations, provider });
    expect(health).toMatchObject({ status: 'unknown', commit: null });
    expect(SystemHealthSchema.safeParse(health).success).toBe(true);
  });

  it('[NFR-OBS-01] converts one result at a time and caps the DTO detail at 400 characters', () => {
    const result = {
      name: 'database',
      kind: 'database',
      critical: true,
      simulated: false,
      status: 'down',
      latencyMs: 12,
      checkedAt: '2026-10-29T09:14:14.599Z',
      detail: 'x'.repeat(900),
      timedOut: false,
      cached: false,
    } satisfies Parameters<typeof toDependencyHealth>[0];
    const dto = toDependencyHealth(result);
    expect(dto).toMatchObject({ status: 'unhealthy', latencyMs: 12 });
    expect(dto.detail).toHaveLength(400);
    expect(toHealthStatus('up')).toBe('healthy');
    expect(toHealthStatus('disabled')).toBe('disabled');
    expect(overallHealthStatus('up', false)).toBe('unknown');
    expect(overallHealthStatus('down', true)).toBe('unhealthy');
  });
});
