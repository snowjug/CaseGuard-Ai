import { IdSchema } from '@caseguard/schemas';
import { describe, expect, it } from 'vitest';
import {
  clampRatio,
  createSampler,
  createSeededRandom,
  createStopwatch,
  createTelemetryEventBuilder,
  hashToUnitInterval,
  measure,
  shouldSample,
  TELEMETRY_EVENT_NAMES,
  TelemetryEventSchema,
  timed,
  timedSync,
  type Measurement,
  type TelemetryEventInput,
} from '../src';
import {
  createManualClock,
  createManualMonotonic,
  seededBytes,
  seededRandom,
} from './helpers/fakes';

describe('timing helpers', () => {
  it('[NFR-OBS-01] timed returns the result with the elapsed milliseconds from the injected clock', async () => {
    const clock = createManualMonotonic();
    const { result, durationMs } = await timed(async () => {
      clock.advance(42.5);
      return 'value';
    }, clock.now);
    expect(result).toBe('value');
    expect(durationMs).toBe(42.5);
    expect(
      timedSync(() => {
        clock.advance(3);
        return 7;
      }, clock.now),
    ).toEqual({ result: 7, durationMs: 3 });
  });

  it('[NFR-OBS-01] timed propagates the original error and never returns a negative duration', async () => {
    const clock = createManualMonotonic();
    const failure = new Error('boom');
    await expect(
      timed(() => {
        throw failure;
      }, clock.now),
    ).rejects.toBe(failure);
    expect(
      (
        await timed(() => {
          clock.advance(-10);
        }, clock.now)
      ).durationMs,
    ).toBe(0);
  });

  it('[NFR-OBS-01] measure reports success and failure to the recorder and returns or rethrows faithfully', async () => {
    const clock = createManualMonotonic();
    const seen: Measurement[] = [];
    const value = await measure(
      () => {
        clock.advance(5);
        return 1;
      },
      (m) => seen.push(m),
      clock.now,
    );
    const failure = new Error('failed');
    await expect(
      measure(
        () => {
          clock.advance(8);
          throw failure;
        },
        (m) => seen.push(m),
        clock.now,
      ),
    ).rejects.toBe(failure);
    expect(value).toBe(1);
    expect(seen).toEqual([
      { durationMs: 5, ok: true },
      { durationMs: 8, ok: false, error: failure },
    ]);
  });

  it('[NFR-OBS-01] measure does not call the recorder a second time when the recorder itself throws on success', async () => {
    let calls = 0;
    await expect(
      measure(
        () => 'ok',
        () => {
          calls += 1;
          throw new Error('recorder broke');
        },
      ),
    ).rejects.toThrow('recorder broke');
    expect(calls).toBe(1);
  });

  it('[NFR-OBS-01] stopwatch reads elapsed time on demand', () => {
    const clock = createManualMonotonic();
    const stopwatch = createStopwatch(clock.now);
    clock.advance(10);
    expect(stopwatch.elapsedMs()).toBe(10);
    clock.advance(5);
    expect(stopwatch.elapsedMs()).toBe(15);
  });
});

describe('privacy-safe telemetry events', () => {
  const clock = createManualClock(Date.parse('2026-10-29T09:14:14.599Z'));
  const build = createTelemetryEventBuilder({
    clock: clock.now,
    generateId: () => 'evt_fixed_000001',
  });
  const valid: TelemetryEventInput = {
    name: 'analysis.completed',
    tenantId: 'tenant_contoso_support',
    caseId: 'case_teams_signin_dns',
    actorId: 'user_ava_engineer',
    requestId: 'req_abcdefgh01',
    synthetic: true,
    counters: { events: 42, hypotheses: 5, forks: 3 },
    durationsMs: { total: 1830.5 },
    flags: { cache_hit: false, simulated: true },
    dimensions: { provider: 'deterministic', outcome: 'succeeded', schema_version: '1.0.0' },
  };

  it('[NFR-OBS-01] builds a deterministic, schema-valid event from ids, counters, durations, flags and enums', () => {
    const result = build(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event).toEqual({
      schemaVersion: 1,
      eventId: 'evt_fixed_000001',
      occurredAt: '2026-10-29T09:14:14.599Z',
      ...valid,
    });
    expect(TelemetryEventSchema.safeParse(result.event).success).toBe(true);
    expect(IdSchema.safeParse(result.event.eventId).success).toBe(true);
  });

  it('[NFR-OBS-01] generates a time-ordered id by default and defaults synthetic to false', () => {
    const result = createTelemetryEventBuilder({ clock: clock.now })({ name: 'case.created' });
    expect(result.ok && result.event.eventId).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(result.ok && result.event.synthetic).toBe(false);
    expect(result.ok && result.event.counters).toEqual({});
  });

  it('[NFR-OBS-01] accepts every documented event name', () => {
    for (const name of TELEMETRY_EVENT_NAMES) expect(build({ name }).ok, name).toBe(true);
  });

  const rejections: [string, Partial<TelemetryEventInput> | Record<string, unknown>][] = [
    ['unknown event name', { name: 'case.text_pasted' as never }],
    [
      'free text in a dimension (spaces, capitals)',
      { dimensions: { note: 'Customer says the sign-in fails' } },
    ],
    ['email in a dimension', { dimensions: { contact: 'fake.person@example.test' } }],
    ['secret-looking dimension', { dimensions: { token: 'abc' } }],
    ['over-long dimension value', { dimensions: { kind: 'a'.repeat(49) } }],
    ['non snake_case bag key', { counters: { 'Case Text': 1 } }],
    ['credential-named counter key', { counters: { password: 1 } }],
    ['PII-named flag key', { flags: { email: true } }],
    ['negative counter', { counters: { events: -1 } }],
    ['fractional counter', { counters: { events: 1.5 } }],
    ['absurd counter', { counters: { events: 1e12 } }],
    ['non-finite duration', { durationsMs: { total: Number.POSITIVE_INFINITY } }],
    [
      'too many counters',
      { counters: Object.fromEntries(Array.from({ length: 21 }, (_u, i) => [`k${i}`, i])) },
    ],
    ['tenant id containing @', { tenantId: 'tenant@example.test' }],
    ['case id with spaces', { caseId: 'case with spaces' }],
    ['empty actor id', { actorId: '' }],
    ['an unexpected content field', { caseContent: 'The customer reported...' }],
  ];

  it.each(rejections)('[NFR-OBS-01] [NFR-SEC-06] rejects %s', (_name, patch) => {
    const result = build({ ...valid, ...patch });
    expect(result.ok).toBe(false);
  });

  it('[NFR-SEC-06] never echoes the offending value in its issues', () => {
    const marker = 'fakeMarkerSensitiveValue99';
    const result = build({
      ...valid,
      dimensions: { note: `${marker} with spaces` },
      caseText: marker,
    } as unknown as TelemetryEventInput);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.join('\n')).not.toContain(marker);
  });

  it('[NFR-SEC-06] keeps the schema strict: unknown top-level fields are rejected', () => {
    const parsed = TelemetryEventSchema.safeParse({
      schemaVersion: 1,
      eventId: 'evt_1',
      name: 'case.created',
      occurredAt: '2026-10-29T09:14:14.599Z',
      synthetic: true,
      counters: {},
      durationsMs: {},
      flags: {},
      dimensions: {},
      caseNotes: 'free text',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('deterministic sampling', () => {
  const keys = Array.from(
    { length: 20_000 },
    (_unused, i) => `trace-${i}-${(i * 2654435761) >>> 0}`,
  );

  it('[NFR-OBS-01] gives the same answer for the same key, ratio and seed, and different seeds disagree', () => {
    const sample = (seed: number) => keys.slice(0, 2000).map((key) => shouldSample(key, 0.5, seed));
    expect(sample(7)).toEqual(sample(7));
    expect(sample(7)).not.toEqual(sample(8));
  });

  it.each([0.01, 0.1, 0.25, 0.5, 0.9])('[NFR-OBS-01] samples about %s of keys', (ratio) => {
    const hits = keys.filter((key) => shouldSample(key, ratio, 42)).length;
    expect(Math.abs(hits / keys.length - ratio)).toBeLessThan(0.02);
  });

  it('[NFR-OBS-01] is monotonic: keys sampled at a lower ratio are sampled at every higher ratio', () => {
    const low = new Set(keys.filter((key) => shouldSample(key, 0.3, 5)));
    for (const key of keys) {
      if (low.has(key)) expect(shouldSample(key, 0.6, 5)).toBe(true);
    }
  });

  it.each([
    [0, false],
    [-1, false],
    [Number.NaN, false],
    [1, true],
    [2, true],
    [Number.POSITIVE_INFINITY, true],
  ])('[NFR-OBS-01] ratio %s always yields %s', (ratio, expected) => {
    for (const key of keys.slice(0, 50)) expect(shouldSample(key, ratio)).toBe(expected);
    expect(clampRatio(ratio)).toBe(expected ? 1 : 0);
  });

  it('[NFR-OBS-01] maps any string, including unicode and empty, into [0, 1)', () => {
    const random = seededRandom(5);
    const alphabet = ['a', 'Z', '0', '-', '_', ' ', 'é', '日', '👍', '\u0000', '\n'];
    for (let i = 0; i < 2000; i += 1) {
      const key = Array.from(
        { length: Math.floor(random() * 30) },
        () => alphabet[Math.floor(random() * alphabet.length)],
      ).join('');
      const unit = hashToUnitInterval(key, i);
      expect(unit).toBeGreaterThanOrEqual(0);
      expect(unit).toBeLessThan(1);
    }
    expect(hashToUnitInterval('')).toBeGreaterThanOrEqual(0);
  });

  it('[NFR-OBS-01] binds a ratio and seed in a reusable sampler', () => {
    const sampler = createSampler({ ratio: 0.25, seed: 9 });
    expect(keys.slice(0, 500).map(sampler)).toEqual(
      keys.slice(0, 500).map((key) => shouldSample(key, 0.25, 9)),
    );
    expect(createSampler({ ratio: 5 })('anything')).toBe(true);
  });

  it('[NFR-OBS-01] seeded random streams are reproducible and roughly uniform', () => {
    const first = createSeededRandom(123);
    const second = createSeededRandom(123);
    const draws = Array.from({ length: 5000 }, () => first());
    expect(draws).toEqual(Array.from({ length: 5000 }, () => second()));
    expect(draws.every((value) => value >= 0 && value < 1)).toBe(true);
    const mean = draws.reduce((sum, value) => sum + value, 0) / draws.length;
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.02);
    expect(seededBytes(1)(4)).toEqual(seededBytes(1)(4));
  });
});
