import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyResourceEnvironment,
  applySdkHealthTelemetryDefaults,
  startTelemetry,
  type AzureMonitorDistro,
} from '../src/telemetry';
import {
  connectionStringFragments,
  createFakeDistro,
  createRig,
  enabledConfig,
  fakeConnectionString,
  telemetryConfig,
  type FakeDistro,
} from './support/telemetry-support';

const fakes: FakeDistro[] = [];

function fakeDistro(...args: Parameters<typeof createFakeDistro>): FakeDistro {
  const created = createFakeDistro(...args);
  fakes.push(created);
  return created;
}

afterEach(() => {
  for (const fake of fakes.splice(0)) fake.cleanup();
});

/** Fails the test when any fragment of the connection string shows up in `text`. */
function expectNoConnectionString(text: string): void {
  for (const fragment of connectionStringFragments()) expect(text).not.toContain(fragment);
}

describe('startTelemetry is off by default', () => {
  it('[NFR-OBS-02] returns a disabled handle without loading the distro when there is no connection string', async () => {
    const rig = createRig();
    const loadDistro = vi.fn(() => Promise.reject(new Error('the distro must not be loaded')));
    const env: NodeJS.ProcessEnv = {};

    const telemetry = await startTelemetry({
      config: telemetryConfig(),
      logger: rig.logger,
      metrics: rig.metrics,
      loadDistro,
      env,
    });

    expect(telemetry.enabled).toBe(false);
    expect(loadDistro).not.toHaveBeenCalled();
    expect(env).toEqual({});
    expect(rig.lines()).toEqual([]);
    expect(rig.errorCount('telemetry', 'exporter_start_failed')).toBe(0);
    await expect(telemetry.shutdown()).resolves.toBeUndefined();
  });

  it('[NFR-OBS-02] stays disabled with a sampling ratio or service name but no connection string', async () => {
    const rig = createRig();
    const fake = fakeDistro();

    const telemetry = await startTelemetry({
      config: telemetryConfig({ OTEL_SAMPLING_RATIO: '0.5', OTEL_SERVICE_NAME: 'custom-api' }),
      logger: rig.logger,
      metrics: rig.metrics,
      loadDistro: () => Promise.resolve(fake.distro),
    });

    expect(telemetry.enabled).toBe(false);
    expect(fake.useCalls).toHaveLength(0);
  });
});

describe('startTelemetry when a connection string is configured', () => {
  it('[NFR-OBS-02] loads the distro once and starts it once with the connection string and the settings', async () => {
    const rig = createRig();
    const env: NodeJS.ProcessEnv = {};
    const fake = fakeDistro({ env });
    const loadDistro = vi.fn(() => Promise.resolve(fake.distro));

    const telemetry = await startTelemetry({
      config: enabledConfig({ OTEL_SAMPLING_RATIO: '0.25', OTEL_SERVICE_NAME: 'caseguard-api-eu' }),
      logger: rig.logger,
      metrics: rig.metrics,
      loadDistro,
      env,
    });

    expect(telemetry.enabled).toBe(true);
    expect(loadDistro).toHaveBeenCalledTimes(1);
    expect(fake.useCalls).toHaveLength(1);
    const [call] = fake.useCalls;
    expect(call?.options.azureMonitorExporterOptions).toEqual({
      connectionString: fakeConnectionString(),
      disableOfflineStorage: true,
    });
    expect(call?.options.samplingRatio).toBe(0.25);
    // Without this the distro's default rate limit of five traces per second would override the ratio.
    expect(call?.options.tracesPerSecond).toBe(0);
    expect(call?.options.enableLiveMetrics).toBe(false);
    expect(call?.options.enablePerformanceCounters).toBe(false);
    expect(call?.options.enableTraceBasedSamplingForLogs).toBe(false);
    expect(call?.options.browserSdkLoaderOptions).toEqual({ enabled: false });
  });

  it('[NFR-SEC-06] switches every automatic instrumentation off, so no URL with a query, SQL text or blob path is exported', async () => {
    const rig = createRig();
    const fake = fakeDistro();

    await startTelemetry({
      config: enabledConfig(),
      logger: rig.logger,
      metrics: rig.metrics,
      loadDistro: () => Promise.resolve(fake.distro),
      env: {},
    });

    const instrumentation = fake.useCalls[0]?.options.instrumentationOptions;
    expect(instrumentation).toEqual({
      http: { enabled: false },
      azureSdk: { enabled: false },
      mongoDb: { enabled: false },
      mySql: { enabled: false },
      postgreSql: { enabled: false },
      redis: { enabled: false },
      redis4: { enabled: false },
      bunyan: { enabled: false },
      winston: { enabled: false },
      console: { enabled: false },
    });
  });

  it('[NFR-OBS-02] publishes the service name, version and environment before the distro starts', async () => {
    const rig = createRig();
    const env: NodeJS.ProcessEnv = {};
    const fake = fakeDistro({ env });

    await startTelemetry({
      config: enabledConfig({ OTEL_SERVICE_NAME: 'caseguard-api-eu' }),
      logger: rig.logger,
      metrics: rig.metrics,
      loadDistro: () => Promise.resolve(fake.distro),
      env,
    });

    expect(fake.useCalls[0]?.env).toMatchObject({
      OTEL_SERVICE_NAME: 'caseguard-api-eu',
      OTEL_RESOURCE_ATTRIBUTES: 'service.version=1.2.3,deployment.environment=test',
    });
  });

  it("[NFR-SEC-06] starts the exporter with Microsoft's SDK health telemetry off, unless the operator chose otherwise", async () => {
    const rig = createRig();
    const defaults: NodeJS.ProcessEnv = {};
    const chosen: NodeJS.ProcessEnv = {
      APPLICATION_INSIGHTS_NO_STATSBEAT: '',
      APPLICATIONINSIGHTS_SDKSTATS_DISABLED: 'false',
    };

    for (const env of [defaults, chosen]) {
      await startTelemetry({
        config: enabledConfig(),
        logger: rig.logger,
        metrics: rig.metrics,
        loadDistro: () => Promise.resolve(fakeDistro({ env }).distro),
        env,
      });
    }

    expect(defaults).toMatchObject({
      APPLICATION_INSIGHTS_NO_STATSBEAT: 'true',
      APPLICATIONINSIGHTS_SDKSTATS_DISABLED: 'true',
    });
    // An explicit choice, even an empty one that turns the feature back on, is never overwritten.
    expect(chosen).toMatchObject({
      APPLICATION_INSIGHTS_NO_STATSBEAT: '',
      APPLICATIONINSIGHTS_SDKSTATS_DISABLED: 'false',
    });
  });

  it('[NFR-OBS-02] uses the service name from SERVICE_NAME when OTEL_SERVICE_NAME is not set', async () => {
    const rig = createRig();
    const env: NodeJS.ProcessEnv = {};

    await startTelemetry({
      config: enabledConfig({ SERVICE_NAME: 'caseguard-api-blue' }),
      logger: rig.logger,
      metrics: rig.metrics,
      loadDistro: () => Promise.resolve(fakeDistro().distro),
      env,
    });

    expect(env['OTEL_SERVICE_NAME']).toBe('caseguard-api-blue');
  });

  it('[NFR-OBS-02] mirrors the product metrics into the registered meter and logs one start line', async () => {
    const rig = createRig();
    const fake = fakeDistro();

    await startTelemetry({
      config: enabledConfig({ OTEL_SAMPLING_RATIO: '0.5' }),
      logger: rig.logger,
      metrics: rig.metrics,
      loadDistro: () => Promise.resolve(fake.distro),
      env: {},
    });
    rig.metrics.recordAuthFailure('invalid_token');
    rig.metrics.recordHttpRequest({
      method: 'GET',
      route: '/api/v1/me',
      statusCode: 200,
      durationMs: 12,
    });

    expect(fake.meter()?.find('caseguard_auth_failures')?.calls).toEqual([
      { kind: 'add', value: 1, attributes: { reason: 'invalid_token' } },
    ]);
    expect(fake.meter()?.find('caseguard_http_request_duration_seconds')?.calls).toHaveLength(1);
    const started = rig.events().filter((line) => line['event'] === 'telemetry.started');
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      level: 'info',
      exporter: 'azure-monitor',
      samplingRatio: 0.5,
      metricsMirrored: true,
    });
  });

  it('[NFR-SEC-06] never writes the connection string anywhere that can be observed', async () => {
    const rig = createRig();
    const fake = fakeDistro();

    const telemetry = await startTelemetry({
      config: enabledConfig(),
      logger: rig.logger,
      metrics: rig.metrics,
      loadDistro: () => Promise.resolve(fake.distro),
      env: {},
    });
    rig.metrics.recordHttpRequest({
      method: 'GET',
      route: '/api/v1/me',
      statusCode: 200,
      durationMs: 1,
    });
    await telemetry.shutdown();

    expectNoConnectionString(rig.output());
    const meter = fake.meter();
    expectNoConnectionString(JSON.stringify(meter?.instruments ?? []));
  });
});

describe('startTelemetry when the exporter cannot start', () => {
  it('[NFR-OBS-02] reports a failing import once, by code, and resolves disabled', async () => {
    const rig = createRig();
    const failure = Object.assign(new Error(`Cannot find ${fakeConnectionString()}`), {
      code: 'ERR_MODULE_NOT_FOUND',
    });

    const telemetry = await startTelemetry({
      config: enabledConfig(),
      logger: rig.logger,
      metrics: rig.metrics,
      loadDistro: () => Promise.reject(failure),
      env: {},
    });

    expect(telemetry.enabled).toBe(false);
    const warnings = rig.events().filter((line) => line['level'] === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      event: 'telemetry.exporter_start_failed',
      phase: 'load',
      code: 'ERR_MODULE_NOT_FOUND',
    });
    expect(rig.errorCount('telemetry', 'exporter_start_failed')).toBe(1);
    expectNoConnectionString(rig.output());
  });

  it('[NFR-SEC-06] does not leak the connection string when the distro rejects it (invalid string, exporter throw)', async () => {
    const rig = createRig();
    const env: NodeJS.ProcessEnv = {};
    const failure = new TypeError(`Invalid connection string ${fakeConnectionString()}`);
    const fake = fakeDistro({ failStart: { value: failure }, env });

    const telemetry = await startTelemetry({
      config: enabledConfig(),
      logger: rig.logger,
      metrics: rig.metrics,
      loadDistro: () => Promise.resolve(fake.distro),
      env,
    });

    expect(telemetry.enabled).toBe(false);
    expect(fake.useCalls).toHaveLength(1);
    expect(rig.events().filter((line) => line['level'] === 'warn')).toMatchObject([
      { event: 'telemetry.exporter_start_failed', phase: 'start', code: 'TypeError' },
    ]);
    expect(rig.errorCount('telemetry', 'exporter_start_failed')).toBe(1);
    expectNoConnectionString(rig.output());
    await telemetry.shutdown();
    expect(fake.shutdownCalls()).toBe(0);
    expect(fake.meter()).toBeUndefined();
  });

  it.each([
    ['a string', fakeConnectionString()],
    ['null', null],
    ['undefined', undefined],
    ['a number', 7],
    ['a symbol', Symbol('boom')],
    ['an object with a hostile name', { name: fakeConnectionString() }],
  ])(
    '[NFR-SEC-06] resolves and stays silent about the value when the distro throws %s',
    async (_label, thrown) => {
      const rig = createRig();
      const fake = fakeDistro({ failStart: { value: thrown } });

      const telemetry = await startTelemetry({
        config: enabledConfig(),
        logger: rig.logger,
        metrics: rig.metrics,
        loadDistro: () => Promise.resolve(fake.distro),
        env: {},
      });

      expect(telemetry.enabled).toBe(false);
      expect(
        rig.events().filter((line) => line['event'] === 'telemetry.exporter_start_failed'),
      ).toHaveLength(1);
      expectNoConnectionString(rig.output());
    },
  );

  it('[NFR-OBS-02] rejects a module that lacks the expected functions with a clear code', async () => {
    const rig = createRig();

    const telemetry = await startTelemetry({
      config: enabledConfig(),
      logger: rig.logger,
      metrics: rig.metrics,
      loadDistro: () => Promise.resolve({} as unknown as AzureMonitorDistro),
      env: {},
    });

    expect(telemetry.enabled).toBe(false);
    expect(
      rig.events().find((line) => line['event'] === 'telemetry.exporter_start_failed'),
    ).toMatchObject({
      phase: 'load',
      code: 'invalid_distro',
    });
  });

  it('[NFR-OBS-02] does not touch the process environment when the distro cannot be loaded', async () => {
    const rig = createRig();
    const env: NodeJS.ProcessEnv = {};

    await startTelemetry({
      config: enabledConfig(),
      logger: rig.logger,
      metrics: rig.metrics,
      loadDistro: () => Promise.reject(new Error('offline')),
      env,
    });

    expect(env).toEqual({});
  });
});

describe('startTelemetry shutdown', () => {
  it('[NFR-OBS-02] flushes exactly once however often and however concurrently it is called', async () => {
    const rig = createRig();
    const fake = fakeDistro();
    const telemetry = await startTelemetry({
      config: enabledConfig(),
      logger: rig.logger,
      metrics: rig.metrics,
      loadDistro: () => Promise.resolve(fake.distro),
      env: {},
    });

    const first = telemetry.shutdown();
    const second = telemetry.shutdown();
    await Promise.all([first, second]);
    await telemetry.shutdown();

    expect(first).toBe(second);
    expect(fake.shutdownCalls()).toBe(1);
  });

  it('[NFR-OBS-02] unbinds the metrics mirror only after the flush, so the last export still sees the gauges', async () => {
    const rig = createRig();
    const fake = fakeDistro();
    const telemetry = await startTelemetry({
      config: enabledConfig(),
      logger: rig.logger,
      metrics: rig.metrics,
      loadDistro: () => Promise.resolve(fake.distro),
      env: {},
    });
    const meter = fake.meter();
    const before = meter?.find('caseguard_auth_failures')?.calls.length ?? 0;

    await telemetry.shutdown();
    rig.metrics.recordAuthFailure('invalid_token');

    expect(fake.callbacksAtShutdown[0]).toBeGreaterThan(0);
    expect(meter?.find('caseguard_auth_failures')?.calls.length ?? 0).toBe(before);
  });

  it('[NFR-OBS-02] never throws when the flush rejects, and does not echo the error message', async () => {
    const rig = createRig();
    const fake = fakeDistro({
      failShutdown: { value: new Error(`flush to ${fakeConnectionString()} failed`) },
    });
    const telemetry = await startTelemetry({
      config: enabledConfig(),
      logger: rig.logger,
      metrics: rig.metrics,
      loadDistro: () => Promise.resolve(fake.distro),
      env: {},
    });

    await expect(telemetry.shutdown()).resolves.toBeUndefined();

    expect(
      rig.events().filter((line) => line['event'] === 'telemetry.shutdown_failed'),
    ).toMatchObject([{ level: 'warn', code: 'Error' }]);
    expect(rig.errorCount('telemetry', 'shutdown_failed')).toBe(1);
    expectNoConnectionString(rig.output());
  });

  it('[NFR-OBS-02] never throws when the distro throws synchronously on shutdown', async () => {
    const rig = createRig();
    const fake = fakeDistro({ failShutdown: { value: new RangeError('sync boom'), sync: true } });
    const telemetry = await startTelemetry({
      config: enabledConfig(),
      logger: rig.logger,
      metrics: rig.metrics,
      loadDistro: () => Promise.resolve(fake.distro),
      env: {},
    });

    await expect(telemetry.shutdown()).resolves.toBeUndefined();
    expect(rig.errorCount('telemetry', 'shutdown_failed')).toBe(1);
  });

  it('[NFR-OBS-02] gives up after the timeout, reports it, and ignores a late failure of the flush', async () => {
    const rig = createRig();
    const fake = fakeDistro({ hangShutdown: true });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const telemetry = await startTelemetry({
        config: enabledConfig(),
        logger: rig.logger,
        metrics: rig.metrics,
        loadDistro: () => Promise.resolve(fake.distro),
        env: {},
        shutdownTimeoutMs: 20,
      });

      const started = Date.now();
      await expect(telemetry.shutdown()).resolves.toBeUndefined();
      expect(Date.now() - started).toBeLessThan(2_000);

      expect(
        rig.events().filter((line) => line['event'] === 'telemetry.shutdown_timeout'),
      ).toMatchObject([{ level: 'warn', timeoutMs: 20 }]);
      expect(rig.errorCount('telemetry', 'shutdown_timeout')).toBe(1);

      fake.settleShutdown({ value: new Error('late failure') });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('applySdkHealthTelemetryDefaults', () => {
  it('[NFR-SEC-06] switches both kinds of SDK health telemetry off on an empty environment', () => {
    const env: NodeJS.ProcessEnv = {};
    applySdkHealthTelemetryDefaults(env);

    expect(env).toEqual({
      APPLICATION_INSIGHTS_NO_STATSBEAT: 'true',
      APPLICATIONINSIGHTS_SDKSTATS_DISABLED: 'true',
    });
  });

  it('[NFR-SEC-06] leaves every variable the operator set, whatever its value', () => {
    const env: NodeJS.ProcessEnv = {
      APPLICATION_INSIGHTS_NO_STATSBEAT: '',
      APPLICATIONINSIGHTS_SDKSTATS_DISABLED: '0',
    };
    applySdkHealthTelemetryDefaults(env);

    expect(env).toEqual({
      APPLICATION_INSIGHTS_NO_STATSBEAT: '',
      APPLICATIONINSIGHTS_SDKSTATS_DISABLED: '0',
    });
  });
});

describe('applyResourceEnvironment', () => {
  const resource = { serviceName: 'caseguard-api', version: '1.2.3', environment: 'staging' };

  it('[NFR-OBS-02] sets the service name and the resource attributes on an empty environment', () => {
    const env: NodeJS.ProcessEnv = {};
    applyResourceEnvironment(env, resource);

    expect(env).toEqual({
      OTEL_SERVICE_NAME: 'caseguard-api',
      OTEL_RESOURCE_ATTRIBUTES: 'service.version=1.2.3,deployment.environment=staging',
    });
  });

  it('[NFR-OBS-02] keeps what an operator already set and adds only what is missing', () => {
    const env: NodeJS.ProcessEnv = {
      OTEL_SERVICE_NAME: 'operator-name',
      OTEL_RESOURCE_ATTRIBUTES: 'service.namespace=caseguard,service.version=9.9.9',
    };
    applyResourceEnvironment(env, resource);

    expect(env['OTEL_SERVICE_NAME']).toBe('operator-name');
    expect(env['OTEL_RESOURCE_ATTRIBUTES']).toBe(
      'service.namespace=caseguard,service.version=9.9.9,deployment.environment=staging',
    );
  });

  it('[NFR-OBS-02] does not set OTEL_SERVICE_NAME when the operator named the service in the attributes', () => {
    const env: NodeJS.ProcessEnv = { OTEL_RESOURCE_ATTRIBUTES: 'service.name=from-attributes' };
    applyResourceEnvironment(env, resource);

    expect(env['OTEL_SERVICE_NAME']).toBeUndefined();
    expect(env['OTEL_RESOURCE_ATTRIBUTES']).toBe(
      'service.name=from-attributes,service.version=1.2.3,deployment.environment=staging',
    );
  });

  it('[NFR-OBS-02] recognises percent-encoded keys and tolerates malformed entries', () => {
    const env: NodeJS.ProcessEnv = {
      OTEL_RESOURCE_ATTRIBUTES: 'service%2Eversion=7,%E0%A4%A=broken,,=novalue',
    };
    applyResourceEnvironment(env, resource);

    expect(env['OTEL_RESOURCE_ATTRIBUTES']).toBe(
      'service%2Eversion=7,%E0%A4%A=broken,,=novalue,deployment.environment=staging',
    );
  });

  it.each([
    ['a comma', 'v1,2', 'v1%2C2'],
    ['an equals sign', 'v=1', 'v%3D1'],
    ['a space', 'v 1', 'v%201'],
    ['a plus sign', '1.2.3+build.5', '1.2.3%2Bbuild.5'],
  ])('[NFR-OBS-02] percent-encodes a version containing %s', (_label, version, encoded) => {
    const env: NodeJS.ProcessEnv = {};
    applyResourceEnvironment(env, { ...resource, version });

    expect(env['OTEL_RESOURCE_ATTRIBUTES']).toBe(
      `service.version=${encoded},deployment.environment=staging`,
    );
  });

  it('[NFR-OBS-02] shortens a very long value so the SDK does not discard the whole variable', () => {
    const env: NodeJS.ProcessEnv = {};
    applyResourceEnvironment(env, { ...resource, version: 'v'.repeat(500) });

    const value = env['OTEL_RESOURCE_ATTRIBUTES']?.split(',')[0]?.split('=')[1] ?? '';
    expect(value.length).toBeLessThanOrEqual(255);
  });
});
