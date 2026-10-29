import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildHealth as build, ok } from './helpers/health';

afterEach(() => {
  vi.useRealTimers();
});

describe('liveness', () => {
  it('[NFR-OBS-01] never calls a dependency, even when every one is failing', () => {
    const { registry } = build();
    const check = vi.fn(() => Promise.reject(new Error('down')));
    registry.registerStandard('database', check);
    registry.registerStandard('search', check);
    expect(registry.liveness()).toEqual({
      status: 'up',
      service: 'caseguard-api',
      version: '1.2.3',
      uptimeSeconds: 125,
      checkedAt: '2026-10-29T09:14:14.599Z',
    });
    expect(check).not.toHaveBeenCalled();
  });

  it('[NFR-OBS-01] reports uptime from the injected clock', () => {
    const { registry, clock } = build();
    clock.advance(76_000);
    expect(registry.liveness().uptimeSeconds).toBe(201);
    clock.advance(999);
    expect(registry.liveness().uptimeSeconds).toBe(201);
  });
});

describe('readiness semantics', () => {
  it('[NFR-OBS-01] is ready and up when every check passes', async () => {
    const { registry } = build();
    registry.registerStandard('database', ok);
    registry.registerStandard('migrations', ok);
    registry.registerStandard('search', ok);
    const report = await registry.readiness();
    expect(report).toMatchObject({
      status: 'up',
      ready: true,
      httpStatus: 200,
      service: 'caseguard-api',
      version: '1.2.3',
    });
    expect(report.checks.map((check) => [check.name, check.status])).toEqual([
      ['database', 'up'],
      ['migrations', 'up'],
      ['search', 'up'],
    ]);
  });

  it.each(['database', 'migrations'] as const)(
    '[NFR-OBS-01] fails readiness when the critical %s check is down',
    async (key) => {
      const { registry } = build();
      registry.registerStandard(
        'database',
        key === 'database' ? () => Promise.reject(new Error('boom')) : ok,
      );
      registry.registerStandard(
        'migrations',
        key === 'migrations' ? () => Promise.reject(new Error('boom')) : ok,
      );
      registry.registerStandard('search', ok);
      const report = await registry.readiness();
      expect(report).toMatchObject({ status: 'down', ready: false, httpStatus: 503 });
    },
  );

  it.each(['storage', 'search', 'modelProvider', 'cache'] as const)(
    '[NFR-OBS-01] stays ready (degraded) when only the non-critical %s check is down',
    async (key) => {
      const { registry } = build();
      registry.registerStandard('database', ok);
      registry.registerStandard('migrations', ok);
      registry.registerStandard(key, () => Promise.reject(new Error('unavailable')));
      const report = await registry.readiness();
      expect(report).toMatchObject({ status: 'degraded', ready: true, httpStatus: 200 });
    },
  );

  it('[NFR-OBS-01] treats a reported degraded state as ready but degraded, even for a critical check', async () => {
    const { registry } = build();
    registry.registerStandard('database', () => ({ status: 'degraded', detail: 'replica lag 4s' }));
    const report = await registry.readiness({ detail: 'full' });
    expect(report).toMatchObject({ status: 'degraded', ready: true });
    expect(report.checks[0]).toMatchObject({ status: 'degraded', detail: 'replica lag 4s' });
  });

  it('[NFR-OBS-01] lets a critical failure win over a non-critical degradation', async () => {
    const { registry } = build();
    registry.registerStandard('search', () => ({ status: 'degraded' }));
    registry.registerStandard('database', () => Promise.reject(new Error('down')));
    expect((await registry.readiness()).status).toBe('down');
  });

  it('[NFR-OBS-01] is ready when nothing is registered, and rejects a check reporting a made-up status', async () => {
    expect((await build().registry.readiness()).ready).toBe(true);
    const { registry } = build();
    registry.registerStandard('database', () => ({ status: 'great' as never }));
    const report = await registry.readiness({ detail: 'full' });
    expect(report).toMatchObject({ ready: false, status: 'down' });
    expect(report.checks[0]?.detail).toBe('Check reported an invalid status.');
  });

  it('[NFR-OBS-01] never rejects: synchronous throws and non-Error rejections become down results', async () => {
    const { registry } = build();
    registry.register({
      name: 'sync_throw',
      kind: 'cache',
      critical: false,
      check: () => {
        throw new Error('sync boom');
      },
    });
    registry.register({
      name: 'reject_string',
      kind: 'search',
      critical: false,
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- simulates a dependency rejecting with a non-Error
      check: () => Promise.reject('plain string failure'),
    });
    const report = await registry.readiness({ detail: 'full' });
    expect(report.checks.map((check) => check.status)).toEqual(['down', 'down']);
    expect(report.checks[0]?.detail).toContain('sync boom');
  });
});

describe('timeouts', () => {
  it('[NFR-OBS-01] marks a hanging check down after its timeout and aborts its signal', async () => {
    vi.useFakeTimers();
    const { registry } = build();
    let signal: AbortSignal | undefined;
    registry.registerStandard(
      'database',
      ({ signal: received }) => {
        signal = received;
        return new Promise<void>(() => undefined);
      },
      { timeoutMs: 50 },
    );
    const pending = registry.readiness({ detail: 'full' });
    await vi.advanceTimersByTimeAsync(49);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const report = await pending;
    expect(report).toMatchObject({ ready: false, status: 'down' });
    expect(report.checks[0]).toMatchObject({ status: 'down', detail: 'Timed out after 50 ms' });
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('[NFR-OBS-01] uses the registry default and per-check overrides, and clears its timer when a check finishes', async () => {
    vi.useFakeTimers();
    const { registry } = build({ defaultTimeoutMs: 30 });
    registry.register({
      name: 'slow_default',
      kind: 'cache',
      critical: false,
      check: () => new Promise<void>(() => undefined),
    });
    registry.register({
      name: 'slow_but_allowed',
      kind: 'search',
      critical: false,
      timeoutMs: 500,
      check: () => new Promise<void>((resolve) => setTimeout(resolve, 100)),
    });
    const pending = registry.readiness({ detail: 'full' });
    await vi.advanceTimersByTimeAsync(31);
    await vi.advanceTimersByTimeAsync(100);
    const report = await pending;
    expect(report.checks[0]?.detail).toBe('Timed out after 30 ms');
    expect(report.checks[1]?.status).toBe('up');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('[NFR-OBS-01] runs checks concurrently, so readiness takes as long as the slowest check', async () => {
    vi.useFakeTimers();
    const { registry } = build();
    for (const name of ['one', 'two', 'three']) {
      registry.register({
        name,
        kind: 'cache',
        critical: false,
        check: () => new Promise<void>((resolve) => setTimeout(resolve, 100)),
      });
    }
    let done = false;
    const pending = registry.readiness().then((report) => {
      done = true;
      return report;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).status).toBe('up');
    expect(done).toBe(true);
  });

  it('[NFR-OBS-01] keeps the timeout verdict when a check finally completes after it timed out', async () => {
    vi.useFakeTimers();
    const { registry } = build();
    let resolveLate: (() => void) | undefined;
    registry.registerStandard(
      'database',
      () =>
        new Promise<void>((resolve) => {
          resolveLate = resolve;
        }),
      { timeoutMs: 10 },
    );
    const pending = registry.readiness();
    await vi.advanceTimersByTimeAsync(11);
    expect((await pending).ready).toBe(false);
    resolveLate?.();
    await vi.advanceTimersByTimeAsync(1);
    const again = await registry.readiness({ detail: 'full' });
    expect(again.ready).toBe(false);
    expect(again.checks[0]?.detail).toBe('Timed out after 10 ms');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('caching and single-flight', () => {
  it('[NFR-OBS-01] reuses a result within its TTL and re-runs after it, using the injected clock', async () => {
    const { registry, clock } = build({ defaultCacheTtlMs: 5000 });
    const check = vi.fn(ok);
    registry.registerStandard('database', check);
    await registry.readiness();
    clock.advance(4999);
    await registry.readiness();
    expect(check).toHaveBeenCalledTimes(1);
    clock.advance(2);
    await registry.readiness();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('[NFR-OBS-01] flags cached results and lets callers force a refresh', async () => {
    const { registry } = build();
    const check = vi.fn(ok);
    registry.registerStandard('database', check);
    expect((await registry.check('database')).cached).toBe(false);
    expect((await registry.check('database')).cached).toBe(true);
    expect((await registry.check('database', { refresh: true })).cached).toBe(false);
    await registry.readiness({ refresh: true });
    expect(check).toHaveBeenCalledTimes(3);
  });

  it('[NFR-OBS-01] caches failures too, so a flood of probes cannot hammer a broken dependency', async () => {
    const { registry, clock } = build();
    const check = vi.fn(() => Promise.reject(new Error('down')));
    registry.registerStandard('database', check, { cacheTtlMs: 1000 });
    for (let i = 0; i < 20; i += 1) await registry.readiness();
    expect(check).toHaveBeenCalledTimes(1);
    clock.advance(1001);
    await registry.readiness();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('[NFR-OBS-01] disables caching with a TTL of 0 and honours per-check TTLs', async () => {
    const { registry } = build();
    const uncached = vi.fn(ok);
    const cached = vi.fn(ok);
    registry.register({
      name: 'uncached',
      kind: 'cache',
      critical: false,
      cacheTtlMs: 0,
      check: uncached,
    });
    registry.register({
      name: 'cached',
      kind: 'cache',
      critical: false,
      cacheTtlMs: 60_000,
      check: cached,
    });
    await registry.readiness();
    await registry.readiness();
    expect(uncached).toHaveBeenCalledTimes(2);
    expect(cached).toHaveBeenCalledTimes(1);
  });

  it('[NFR-OBS-01] shares one in-flight execution between concurrent probes', async () => {
    vi.useFakeTimers();
    const { registry } = build({ defaultCacheTtlMs: 0 });
    const check = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
    registry.registerStandard('database', check);
    const probes = Array.from({ length: 25 }, () => registry.readiness());
    await vi.advanceTimersByTimeAsync(50);
    const reports = await Promise.all(probes);
    expect(check).toHaveBeenCalledTimes(1);
    expect(reports.every((report) => report.ready)).toBe(true);
  });

  it('[NFR-OBS-01] measures latency with the monotonic clock', async () => {
    const { registry, monotonic } = build();
    registry.registerStandard('database', () => {
      monotonic.advance(37.5);
    });
    expect((await registry.check('database')).latencyMs).toBe(37.5);
  });
});
