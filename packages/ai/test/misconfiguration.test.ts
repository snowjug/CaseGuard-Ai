import { describe, expect, it } from 'vitest';
import { AiTaskError, ProviderError, type AgentTask, type ProviderErrorCode } from '../src';
import { ScriptedProvider } from './fakes';
import { hypTask, one, run, setup } from './orchestrator-harness';
import {
  classifierTask,
  coachTask,
  forkTask,
  qualityTask,
  timelineTask,
  validOutput,
} from './tasks';

const failure = (
  code: ProviderErrorCode,
  status: number | null = null,
  causeCode: string | null = null,
) => new ProviderError(code, `simulated ${code}`, { status, causeCode });

const T = {
  hypothesis: hypTask,
  timeline: timelineTask(one),
  classifier: classifierTask(one),
  fork: forkTask(one),
  quality: qualityTask(one),
  coach: coachTask(one),
} satisfies Record<string, AgentTask>;
const SIX: AgentTask[] = Object.values(T);

const succeed = (request: { task: AgentTask }) => ({
  output: validOutput(request.task as never) as unknown,
});

describe('a persistent configuration fault is visible and stops costing calls [NFR-REL-01]', () => {
  const FAULTS: [string, ProviderErrorCode, number | null][] = [
    ['a deployment that does not exist (HTTP 404)', 'bad_request', 404],
    ['rejected credentials (HTTP 401)', 'unauthorized', 401],
    ['denied access (HTTP 403)', 'forbidden', 403],
    ['an unusable endpoint or deployment setting', 'not_configured', null],
  ];

  it.each(FAULTS)(
    '[NFR-REL-01] stops calling the provider after three consecutive faults: %s',
    async (_name, code, status) => {
      const provider = new ScriptedProvider([{ error: failure(code, status, 'SomeCause') }]);
      const { orchestrator } = setup(provider);
      const results = [];
      for (const task of SIX) results.push(await run(orchestrator, task));

      expect(provider.requests).toHaveLength(3);
      expect(results.map((r) => r.modelExecution.status)).toEqual([
        'failed',
        'failed',
        'failed',
        'circuit_open',
        'circuit_open',
        'circuit_open',
      ]);
      expect(results.every((r) => r.source === 'deterministic_fallback')).toBe(true);
      const health = orchestrator.getHealth();
      expect(health).toMatchObject({ status: 'degraded', degraded: true, misconfigured: true });
      expect(health.provider.healthy).toBe(false);
      expect(health.degradedReason).toMatch(/configuration/i);
      expect(health.degradedReason).toContain(code);
      expect(health.breakers[0]).toMatchObject({ state: 'open', consecutiveFailures: 3 });
      expect(health.lastFailure).toMatchObject({
        code,
        status,
        causeCode: 'SomeCause',
        configurationFault: true,
      });
      expect(health.notes.join(' ')).toMatch(/misconfigured|configuration/i);
    },
    120_000,
  );

  it('[NFR-REL-01] probes again after the reset time, and recovers once the configuration is fixed', async () => {
    let fixed = false;
    const provider = new ScriptedProvider([
      (request) =>
        fixed ? succeed(request) : { error: failure('bad_request', 404, 'DeploymentNotFound') },
    ]);
    const { orchestrator, clock } = setup(provider, {
      circuitBreaker: { failureThreshold: 5, resetMs: 30_000 },
    });
    for (const task of [T.hypothesis, T.timeline, T.classifier]) await run(orchestrator, task);
    expect(orchestrator.getHealth().misconfigured).toBe(true);

    const blocked = await run(orchestrator, T.fork);
    expect(blocked.modelExecution.status).toBe('circuit_open');
    expect(provider.requests).toHaveLength(3);

    clock.advance(30_000);
    expect(orchestrator.getHealth().breakers[0]?.state).toBe('half_open');
    const probe = await run(orchestrator, T.quality);
    expect(provider.requests).toHaveLength(4);
    expect(probe.modelExecution.status).toBe('failed');
    expect(orchestrator.getHealth()).toMatchObject({ misconfigured: true });
    expect(orchestrator.getHealth().breakers[0]?.state).toBe('open');

    fixed = true;
    clock.advance(30_000);
    const recovered = await run(orchestrator, T.coach);
    expect(recovered.source).toBe('model');
    const health = orchestrator.getHealth();
    expect(health).toMatchObject({ status: 'healthy', degraded: false, misconfigured: false });
    expect(health.breakers[0]).toMatchObject({ state: 'closed', consecutiveFailures: 0 });
    expect(health.provider.healthy).toBe(true);
    expect(health.lastFailure ?? null).toBeNull();
  }, 120_000);

  it('[NFR-REL-01] a success in between resets the streak: fault, fault, success, fault, fault does not trip', async () => {
    const plan = ['fault', 'fault', 'ok', 'fault', 'fault'];
    const provider = new ScriptedProvider([
      (request, call) =>
        plan[call] === 'ok'
          ? succeed(request)
          : { error: failure('bad_request', 404, 'DeploymentNotFound') },
    ]);
    const { orchestrator } = setup(provider);
    for (const task of SIX.slice(0, 5)) await run(orchestrator, task);

    expect(provider.requests).toHaveLength(5);
    const health = orchestrator.getHealth();
    expect(health.breakers[0]?.state).toBe('closed');
    expect(health).toMatchObject({ misconfigured: false, status: 'degraded' });
    expect(health.provider.healthy).toBe(false);
    expect(health.lastFailure).toMatchObject({ code: 'bad_request', configurationFault: true });
  }, 120_000);

  it('[NFR-REL-01] other 4xx rejections (a prompt the service refuses) are not configuration faults', async () => {
    const provider = new ScriptedProvider([{ error: failure('bad_request', 400, 'BadRequest') }]);
    const { orchestrator } = setup(provider);
    for (const task of SIX.slice(0, 4)) await run(orchestrator, task);
    expect(provider.requests).toHaveLength(4);
    const health = orchestrator.getHealth();
    expect(health.breakers[0]).toMatchObject({ state: 'closed', consecutiveFailures: 0 });
    expect(health.misconfigured).toBe(false);
    expect(health.lastFailure).toMatchObject({ status: 400, configurationFault: false });
  }, 120_000);
});

describe('health shows the last failed call [NFR-OBS-01]', () => {
  const KINDS: [ProviderErrorCode, number | null][] = [
    ['content_filtered', 400],
    ['bad_request', 400],
    ['model_refusal', null],
    ['timeout', null],
    ['rate_limited', 429],
    ['server_error', 503],
    ['network', null],
    ['invalid_response', null],
  ];

  it.each(KINDS)(
    '[NFR-OBS-01] a failed call (%s) turns the provider status to degraded at once, and a later success heals it',
    async (code, status) => {
      const provider = new ScriptedProvider([
        { error: failure(code, status, 'SomeCause') },
        (request) => succeed(request),
      ]);
      const { orchestrator } = setup(provider);
      expect(orchestrator.getHealth().provider.healthy).toBeNull();

      await run(orchestrator, T.hypothesis);
      const failed = orchestrator.getHealth();
      expect(failed).toMatchObject({ status: 'degraded', degraded: true, misconfigured: false });
      expect(failed.provider.healthy).toBe(false);
      expect(failed.provider.detail).toContain(code);
      expect(failed.dependency).toMatchObject({ status: 'degraded', latencyMs: null });
      expect(failed.degradedReason).toMatch(/last AI provider call failed/i);
      expect(failed.lastFailure).toMatchObject({ code, status, causeCode: 'SomeCause' });
      expect(failed.breakers[0]?.state).toBe('closed');

      await run(orchestrator, T.timeline);
      const healed = orchestrator.getHealth();
      expect(healed).toMatchObject({ status: 'healthy', degraded: false, degradedReason: null });
      expect(healed.provider.healthy).toBe(true);
      expect(healed.lastFailure ?? null).toBeNull();
    },
    120_000,
  );

  it('[NFR-OBS-01] a call the caller cancelled says nothing about the provider', async () => {
    const controller = new AbortController();
    const provider = new ScriptedProvider([
      { before: () => controller.abort(), error: failure('cancelled') },
    ]);
    const { orchestrator } = setup(provider);
    const error = await run(orchestrator, T.hypothesis, { signal: controller.signal }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AiTaskError);
    const health = orchestrator.getHealth();
    expect(health.provider.healthy).toBeNull();
    expect(health.status).toBe('unknown');
    expect(health.lastFailure ?? null).toBeNull();
  });
});

describe('failures are logged with a sanitised cause [NFR-OBS-01]', () => {
  it('[NFR-OBS-01] logs code, status and cause code, never the message, a URL or a header', async () => {
    const provider = new ScriptedProvider([
      {
        error: new ProviderError(
          'bad_request',
          'Rejected https://secret.example/openai/deployments/x with Authorization: Bearer abc123',
          { status: 404, causeCode: 'DeploymentNotFound', attempts: 2 },
        ),
      },
    ]);
    const { orchestrator, logger, metrics } = setup(provider);
    await run(orchestrator, T.hypothesis);

    const entry = logger.entries.find((e) => e.fields.event === 'ai.provider.failure');
    expect(entry?.level).toBe('warn');
    expect(entry?.fields).toEqual({
      event: 'ai.provider.failure',
      agent: 'hypothesis_generator',
      provider: 'azure-openai',
      code: 'bad_request',
      status: 404,
      causeCode: 'DeploymentNotFound',
      attempts: 2,
      configurationFault: true,
    });
    expect(JSON.stringify(entry)).not.toMatch(/secret\.example|Bearer|abc123|Rejected/);
    expect(metrics.sum('ai.provider.failure', { code: 'bad_request', configuration: 'true' })).toBe(
      1,
    );
  });

  it('[NFR-OBS-01] logs nothing for a cancelled call', async () => {
    const controller = new AbortController();
    const provider = new ScriptedProvider([
      { before: () => controller.abort(), error: failure('cancelled') },
    ]);
    const { orchestrator, logger } = setup(provider);
    await run(orchestrator, T.hypothesis, { signal: controller.signal }).catch(() => undefined);
    expect(logger.entries.some((e) => e.fields.event === 'ai.provider.failure')).toBe(false);
  });
});
