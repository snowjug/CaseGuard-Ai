import { describe, expect, it } from 'vitest';
import { Bulkhead, CircuitBreaker, ProviderError } from '../src';
import { FakeClock, capturingLogger, capturingMetrics } from './fakes';

function breakerOf(threshold = 3, resetMs = 30_000, probes = 1) {
  const clock = new FakeClock();
  const logger = capturingLogger();
  const metrics = capturingMetrics();
  const breaker = new CircuitBreaker({
    name: 'azure-openai',
    failureThreshold: threshold,
    resetMs,
    clock,
    logger,
    metrics,
    halfOpenMaxProbes: probes,
  });
  return { breaker, clock, logger, metrics };
}

describe('CircuitBreaker [NFR-REL-01]', () => {
  it('[NFR-REL-01] opens after the failure threshold and rejects calls while open', () => {
    const { breaker } = breakerOf(3);
    expect(breaker.state()).toBe('closed');
    for (let i = 0; i < 2; i++) {
      expect(breaker.tryAcquire()).toBe(true);
      breaker.recordFailure();
    }
    expect(breaker.state()).toBe('closed');
    breaker.recordFailure();
    expect(breaker.state()).toBe('open');
    expect(breaker.tryAcquire()).toBe(false);
    expect(breaker.snapshot()).toMatchObject({
      name: 'azure-openai',
      state: 'open',
      consecutiveFailures: 3,
    });
  });

  it('[NFR-REL-01] a success resets the consecutive-failure count', () => {
    const { breaker } = breakerOf(3);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state()).toBe('closed');
  });

  it('[NFR-REL-01] goes half-open after the reset time and closes on a successful probe', () => {
    const { breaker, clock } = breakerOf(2, 30_000);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state()).toBe('open');
    clock.advance(29_999);
    expect(breaker.state()).toBe('open');
    clock.advance(1);
    expect(breaker.state()).toBe('half_open');
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.tryAcquire()).toBe(false);
    breaker.recordSuccess();
    expect(breaker.state()).toBe('closed');
    expect(breaker.snapshot()).toMatchObject({ consecutiveFailures: 0, openedAt: null });
    expect(breaker.tryAcquire()).toBe(true);
  });

  it('[NFR-REL-01] reopens immediately when the half-open probe fails', () => {
    const { breaker, clock } = breakerOf(2, 10_000);
    breaker.recordFailure();
    breaker.recordFailure();
    clock.advance(10_000);
    expect(breaker.tryAcquire()).toBe(true);
    breaker.recordFailure();
    expect(breaker.state()).toBe('open');
    expect(breaker.tryAcquire()).toBe(false);
    clock.advance(10_000);
    expect(breaker.state()).toBe('half_open');
  });

  it('[NFR-REL-01] releases the probe slot when a call ends without a verdict on provider health', () => {
    const { breaker, clock } = breakerOf(1, 1_000);
    breaker.recordFailure();
    clock.advance(1_000);
    expect(breaker.tryAcquire()).toBe(true);
    breaker.recordNeutral();
    expect(breaker.tryAcquire()).toBe(true);
  });

  it('[NFR-OBS-01] reports openedAt and logs and measures every state transition', () => {
    const { breaker, clock, logger, metrics } = breakerOf(1, 5_000);
    breaker.recordFailure();
    expect(breaker.snapshot().openedAt).toBe(new Date(clock.nowMs()).toISOString());
    clock.advance(5_000);
    breaker.state();
    breaker.recordSuccess();
    const transitions = logger.entries
      .filter((e) => e.fields.event === 'ai.circuit.transition')
      .map((e) => [e.fields.from, e.fields.to]);
    expect(transitions).toEqual([
      ['closed', 'open'],
      ['open', 'half_open'],
      ['half_open', 'closed'],
    ]);
    expect(metrics.entries.filter((e) => e.name === 'ai.circuit.open').map((e) => e.value)).toEqual(
      [1, 0, 0],
    );
  });

  it('classifies which provider failures count toward the breaker', () => {
    const counts = (code: ConstructorParameters<typeof ProviderError>[0]) =>
      new ProviderError(code, 'x').countsTowardBreaker;
    for (const code of [
      'timeout',
      'rate_limited',
      'server_error',
      'network',
      'unauthorized',
      'invalid_response',
    ] as const)
      expect(counts(code), code).toBe(true);
    for (const code of [
      'cancelled',
      'content_filtered',
      'bad_request',
      'model_refusal',
      'overloaded',
    ] as const)
      expect(counts(code), code).toBe(false);
  });

  it('[NFR-REL-01] classifies which failures are a persistent configuration fault', () => {
    const fault = (code: ConstructorParameters<typeof ProviderError>[0], status: number | null) =>
      new ProviderError(code, 'x', { status }).isConfigurationFault;
    expect(fault('unauthorized', 401)).toBe(true);
    expect(fault('forbidden', 403)).toBe(true);
    expect(fault('not_configured', null)).toBe(true);
    expect(fault('bad_request', 404)).toBe(true);
    expect(fault('bad_request', 400)).toBe(false);
    expect(fault('bad_request', null)).toBe(false);
    for (const code of [
      'timeout',
      'rate_limited',
      'server_error',
      'network',
      'content_filtered',
      'model_refusal',
      'invalid_response',
      'overloaded',
      'cancelled',
    ] as const)
      expect(fault(code, null), code).toBe(false);
  });
});

describe('CircuitBreaker configuration faults [NFR-REL-01]', () => {
  it('[NFR-REL-01] opens after three consecutive configuration faults, below a higher failure threshold', () => {
    const { breaker } = breakerOf(5);
    breaker.recordConfigurationFault();
    breaker.recordConfigurationFault();
    expect(breaker.state()).toBe('closed');
    expect(breaker.misconfigured).toBe(false);
    breaker.recordConfigurationFault();
    expect(breaker.state()).toBe('open');
    expect(breaker.misconfigured).toBe(true);
    expect(breaker.configurationFaults()).toBe(3);
    expect(breaker.snapshot()).toMatchObject({ state: 'open', consecutiveFailures: 3 });
    expect(breaker.tryAcquire()).toBe(false);
  });

  it('[NFR-REL-01] the threshold is configurable', () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker({
      name: 'azure-openai',
      failureThreshold: 10,
      configFaultThreshold: 2,
      resetMs: 1_000,
      clock,
    });
    breaker.recordConfigurationFault();
    expect(breaker.state()).toBe('closed');
    breaker.recordConfigurationFault();
    expect(breaker.state()).toBe('open');
  });

  it('[NFR-REL-01] a success clears the configuration-fault streak', () => {
    const { breaker } = breakerOf(5);
    breaker.recordConfigurationFault();
    breaker.recordConfigurationFault();
    breaker.recordSuccess();
    expect(breaker.configurationFaults()).toBe(0);
    breaker.recordConfigurationFault();
    breaker.recordConfigurationFault();
    expect(breaker.state()).toBe('closed');
  });

  it('[NFR-REL-01] other failures do not clear the streak, and neutral outcomes do not extend it', () => {
    const { breaker } = breakerOf(10);
    breaker.recordConfigurationFault();
    breaker.recordFailure();
    breaker.recordNeutral();
    breaker.recordConfigurationFault();
    expect(breaker.configurationFaults()).toBe(2);
    breaker.recordConfigurationFault();
    expect(breaker.state()).toBe('open');
  });

  it('[NFR-REL-01] a configuration fault during the half-open probe reopens at once and stays "misconfigured"', () => {
    const { breaker, clock } = breakerOf(5, 10_000);
    for (let i = 0; i < 3; i++) breaker.recordConfigurationFault();
    clock.advance(10_000);
    expect(breaker.tryAcquire()).toBe(true);
    breaker.recordConfigurationFault();
    expect(breaker.state()).toBe('open');
    expect(breaker.misconfigured).toBe(true);
    clock.advance(10_000);
    expect(breaker.tryAcquire()).toBe(true);
    breaker.recordSuccess();
    expect(breaker.state()).toBe('closed');
    expect(breaker.misconfigured).toBe(false);
  });

  it('[NFR-OBS-01] the transition log says why the breaker opened', () => {
    const configuration = breakerOf(5);
    for (let i = 0; i < 3; i++) configuration.breaker.recordConfigurationFault();
    const failures = breakerOf(2);
    failures.breaker.recordFailure();
    failures.breaker.recordFailure();
    const reasonOf = (logger: ReturnType<typeof capturingLogger>) =>
      logger.entries.find((e) => e.fields.event === 'ai.circuit.transition')?.fields.reason;
    expect(reasonOf(configuration.logger)).toBe('configuration_faults');
    expect(reasonOf(failures.logger)).toBe('failure_threshold');
  });
});

describe('Bulkhead [NFR-REL-01]', () => {
  const deferred = () => {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  it('[NFR-REL-01] limits concurrency, queues the overflow in order and rejects beyond the queue', async () => {
    const bulkhead = new Bulkhead({ name: 'azure-openai', maxConcurrent: 1, maxQueue: 1 });
    const order: string[] = [];
    const gate = deferred();
    const first = bulkhead.run(async () => {
      order.push('first-start');
      await gate.promise;
      order.push('first-end');
    });
    const second = bulkhead.run(() => {
      order.push('second');
      return Promise.resolve();
    });
    await expect(bulkhead.run(() => Promise.resolve())).rejects.toMatchObject({
      code: 'overloaded',
    });
    expect(bulkhead.stats()).toMatchObject({ active: 1, queued: 1, rejected: 1 });
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
    expect(bulkhead.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  it('[NFR-REL-01] a queued request can be cancelled without consuming capacity', async () => {
    const bulkhead = new Bulkhead({ name: 'x', maxConcurrent: 1, maxQueue: 2 });
    const gate = deferred();
    const running = bulkhead.run(() => gate.promise);
    const controller = new AbortController();
    const queued = bulkhead.run(() => Promise.resolve('never'), controller.signal);
    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: 'cancelled' });
    expect(bulkhead.stats().queued).toBe(0);
    gate.resolve();
    await running;
    await expect(bulkhead.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('releases capacity when the task throws', async () => {
    const bulkhead = new Bulkhead({ name: 'x', maxConcurrent: 1, maxQueue: 0 });
    await expect(bulkhead.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(bulkhead.run(() => Promise.resolve(1))).resolves.toBe(1);
  });
});
