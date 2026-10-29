import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@caseguard/security';
import { findExample } from '../src/samples';
import { runPipeline } from '../src/services/ingestion/pipeline';
import type { PipelineEnv } from '../src/services/ingestion/types';
import { bundleOf, pipelineEnv, transcriptOf, uploadOf } from './ingestion-fixtures';

const env = pipelineEnv;
const upload = uploadOf;

const run = (bundle: unknown, overrides: Partial<PipelineEnv> = {}) =>
  runPipeline({ type: 'bundle', bundle }, env(overrides));

describe('synthetic-data policy', () => {
  it('refuses a bundle that declares synthetic: false in a synthetic workspace', async () => {
    const outcome = await run(bundleOf({ synthetic: false }));
    expect(outcome.preview.ok).toBe(false);
    expect(outcome.prepared).toBeNull();
    expect(outcome.preview.issues[0]).toMatchObject({ path: 'synthetic', severity: 'error' });
    expect(outcome.preview.issues[0]?.message).toContain('synthetic data only');
  });

  it('accepts it in a workspace provisioned as non-synthetic, flagged and with a note', async () => {
    const outcome = await run(bundleOf({ synthetic: false }), { tenantSynthetic: false });
    expect(outcome.preview).toMatchObject({ ok: true, synthetic: false });
    expect(outcome.preview.issues).toEqual([
      expect.objectContaining({ path: 'synthetic', severity: 'warning' }),
    ]);
    expect(outcome.preview.issues[0]?.message.startsWith('Note:')).toBe(true);
  });
});

describe('pasted text (FR-ING-01, FR-ING-02)', () => {
  const lines = [
    'Teams sign-in fails for about 20 users.',
    'Please send two failed sign-in times.',
  ];

  it('derives the synthetic label from the tenant and says so as a note', async () => {
    const outcome = await runPipeline({ type: 'paste', text: transcriptOf(lines) }, env());
    expect(outcome.preview).toMatchObject({
      ok: true,
      sourceKind: 'pasted_text',
      synthetic: true,
      summary: { eventCount: 2 },
    });
    const note = outcome.preview.issues.find((issue) => issue.path === 'synthetic');
    expect(note?.severity).toBe('warning');
    expect(note?.message).toContain('labelled synthetic');
    expect(outcome.prepared?.fileName).toBeNull();
  });

  it('treats pasted text as real data in a non-synthetic workspace', async () => {
    const outcome = await runPipeline(
      { type: 'paste', text: transcriptOf(lines) },
      env({ tenantSynthetic: false }),
    );
    expect(outcome.preview).toMatchObject({ ok: true, synthetic: false });
    expect(outcome.preview.issues.find((issue) => issue.path === 'synthetic')?.message).toContain(
      'not marked synthetic',
    );
  });

  it('passes the title and workload of the request to the parser', async () => {
    const outcome = await runPipeline(
      {
        type: 'paste',
        text: transcriptOf(lines),
        title: 'Sign-in failures at one site',
        workload: 'teams-authentication',
      },
      env(),
    );
    expect(outcome.preview.summary).toMatchObject({
      title: 'Sign-in failures at one site',
      workload: 'teams-authentication',
    });
    expect(
      outcome.preview.issues.some((issue) => issue.message.includes('No workload was supplied')),
    ).toBe(false);
  });

  it('[FR-ING-02] reports unreadable text as a failed preview with a field-level issue, not as an error', async () => {
    const text = 'just some words without any structure';
    const outcome = await runPipeline({ type: 'paste', text }, env());
    expect(outcome.preview).toMatchObject({
      ok: false,
      summary: null,
      eventsPreview: [],
      synthetic: false,
      contentHash: sha256Hex(text),
    });
    expect(outcome.preview.issues[0]).toMatchObject({ severity: 'error', path: '(input)' });
    expect(outcome.prepared).toBeNull();
  });

  it('accepts the transcript example and the CSV example of the download list', async () => {
    const transcript = findExample('transcript-teams-signin-proxy');
    const csv = findExample('events-teams-signin-proxy');
    const fromText = await runPipeline({ type: 'paste', text: transcript?.text ?? '' }, env());
    expect(fromText.preview).toMatchObject({
      ok: true,
      summary: { reference: 'CG-SYN-2001', eventCount: 15 },
    });
    const fromFile = await runPipeline(
      { type: 'file', file: upload('events.csv', csv?.text ?? '', 'text/csv') },
      env(),
    );
    expect(fromFile.preview).toMatchObject({
      ok: true,
      sourceKind: 'uploaded_file',
      summary: { eventCount: 13 },
    });
  });
});
