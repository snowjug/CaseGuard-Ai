import { describe, expect, it } from 'vitest';
import { runPipeline } from '../src/services/ingestion/pipeline';
import type { PipelineEnv } from '../src/services/ingestion/types';
import { bundleOf, pipelineEnv, secrets } from './ingestion-fixtures';

/*
 * Redaction can make a value longer than the limit it satisfied when it was parsed. The repository
 * enforces some of those limits again when it stores a case, so the pipeline runs the bundle schema
 * on the redacted bundle: a preview then refuses exactly what a create would (review M2c).
 */

const run = (bundle: unknown, overrides: Partial<PipelineEnv> = {}) =>
  runPipeline({ type: 'bundle', bundle }, pipelineEnv(overrides));

/** A copy of the bundle with one event patched (its position in the file, not its id). */
function withEvent(
  bundle: Record<string, unknown>,
  index: number,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const events = (bundle.events as Record<string, unknown>[]).map((event, position) =>
    position === index ? { ...event, ...patch } : event,
  );
  return { ...bundle, events };
}

const labelBundle = (label: string) =>
  withEvent(bundleOf(), 1, { action: { label, customerEffort: 'none', destructive: false } });
const errorsOf = (outcome: Awaited<ReturnType<typeof run>>) =>
  outcome.preview.issues.filter((issue) => issue.severity === 'error');

/** 28 short e-mail addresses: 195 characters, far more once each one is replaced by a placeholder. */
const MAILS = 'a@b.co '.repeat(28).trim();

describe('the redacted bundle is validated again (review M2c)', () => {
  it('refuses an action label that redaction pushed past 200 characters, with its field path', async () => {
    expect(MAILS.length).toBeLessThanOrEqual(200);
    const outcome = await run(labelBundle(MAILS));
    expect(outcome.preview.ok).toBe(false);
    expect(outcome.prepared).toBeNull();
    expect(errorsOf(outcome)).toEqual([
      expect.objectContaining({ path: 'events[1].action.label', severity: 'error' }),
    ]);
    expect(errorsOf(outcome)[0]?.message).toMatch(/^After redaction: .*200 characters/);
    expect(outcome.preview.redaction.totalReplacements).toBe(28);
  });

  it('refuses a structured value and an event body that redaction pushed past their limits', async () => {
    const ips = Array.from({ length: 40 }, (_, index) => `8.8.${index}.${index}`).join(',');
    const structured = await run(bundleOf({ structured: { clientIps: ips } }));
    expect(structured.preview.ok).toBe(false);
    expect(errorsOf(structured).map((issue) => issue.path)).toEqual([
      'events[0].structured.clientIps',
    ]);

    const body = await run(bundleOf({ body: 'a@b.co '.repeat(2857) }));
    expect(body.preview.ok).toBe(false);
    expect(errorsOf(body).map((issue) => issue.path)).toEqual(['events[0].body']);
  });

  it('accepts a value at its limit when nothing was replaced, and a redaction that stays within it', async () => {
    const atTheLimit = await run(labelBundle('x'.repeat(200)));
    expect(atTheLimit.preview).toMatchObject({ ok: true, redaction: { totalReplacements: 0 } });

    const fewMails = await run(labelBundle('a@b.co, c@d.co and e@f.co were notified'));
    expect(fewMails.preview.ok).toBe(true);
    expect(fewMails.preview.redaction.totalReplacements).toBe(3);
    expect(fewMails.prepared?.bundle.events[1]?.action?.label).not.toContain('@');
  });

  it('reports every field that is too long, not only the first', async () => {
    const bundle = withEvent(bundleOf(), 1, {
      action: { label: MAILS, customerEffort: 'none', destructive: false },
    });
    const events = bundle.events as Record<string, unknown>[];
    events[2] = {
      ...events[2],
      action: { label: MAILS, customerEffort: 'none', destructive: false },
    };
    const outcome = await run(bundle);
    expect(errorsOf(outcome).map((issue) => issue.path)).toEqual([
      'events[1].action.label',
      'events[2].action.label',
    ]);
  });

  it('never lets a secret into the message even when the field it sits in is the one refused', async () => {
    const token = secrets.githubToken(61);
    const outcome = await run(labelBundle(`${token} ${MAILS}`.slice(0, 200)));
    expect(outcome.preview.ok).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain(token);
  });

  it('judges the redacted bundle by the same rules whatever the source (pasted text included)', async () => {
    const text = `2026-05-05T09:00:00Z - Customer - ${'a@b.co '.repeat(2857)}`;
    const outcome = await runPipeline({ type: 'paste', text }, pipelineEnv());
    expect(outcome.preview.ok).toBe(false);
    expect(errorsOf(outcome).map((issue) => issue.path)).toContain('events[0].body');
  });
});
