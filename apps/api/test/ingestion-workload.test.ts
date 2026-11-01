import { describe, expect, it } from 'vitest';
import { findExample } from '../src/samples';
import { runPipeline } from '../src/services/ingestion/pipeline';
import { bundleOf, pipelineEnv, transcriptOf, uploadOf } from './ingestion-fixtures';

const lines = ['Teams sign-in fails for about 20 users.', 'Please send two failed sign-in times.'];

type Outcome = Awaited<ReturnType<typeof runPipeline>>;
const workloadIssues = (outcome: Outcome) =>
  outcome.preview.issues.filter((issue) => issue.path === 'case.workload');
const mentionsAssumption = (outcome: Outcome): boolean =>
  outcome.preview.issues.some((issue) => issue.message.includes('No workload was supplied'));

describe('[FR-ING-01] the workload is stated where it can be, or the case is refused at the door', () => {
  it('refuses pasted text that states no workload, says how to state it, and keeps nothing to store', async () => {
    const outcome = await runPipeline({ type: 'paste', text: transcriptOf(lines) }, pipelineEnv());

    expect(outcome.preview.ok).toBe(false);
    expect(outcome.prepared).toBeNull();
    const issues = workloadIssues(outcome);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('error');
    expect(issues[0]?.message).toContain('does not guess');
    expect(issues[0]?.message).toContain('Workload field');
    expect(issues[0]?.message).toContain('Supported workloads: teams-authentication');
    // The old quiet default is gone: the preview no longer says the workload was assumed.
    expect(mentionsAssumption(outcome)).toBe(false);
  });

  it('accepts pasted text whose request states a supported workload', async () => {
    const outcome = await runPipeline(
      { type: 'paste', text: transcriptOf(lines), workload: 'teams-authentication' },
      pipelineEnv(),
    );

    expect(outcome.preview).toMatchObject({
      ok: true,
      summary: { workload: 'teams-authentication' },
    });
    expect(outcome.prepared).not.toBeNull();
    expect(workloadIssues(outcome)).toEqual([]);
    expect(mentionsAssumption(outcome)).toBe(false);
  });

  it('accepts pasted text that carries its own Workload line', async () => {
    const transcript = findExample('transcript-teams-signin-proxy');
    const outcome = await runPipeline(
      { type: 'paste', text: transcript?.text ?? '' },
      pipelineEnv(),
    );

    expect(outcome.preview).toMatchObject({
      ok: true,
      summary: { workload: 'teams-authentication' },
    });
    expect(workloadIssues(outcome)).toEqual([]);
    expect(mentionsAssumption(outcome)).toBe(false);
  });

  it('refuses a workload that no knowledge pack covers, naming it and the supported ones', async () => {
    const outcome = await runPipeline(
      { type: 'paste', text: transcriptOf(lines), workload: 'quantum-routing' },
      pipelineEnv(),
    );

    expect(outcome.preview.ok).toBe(false);
    expect(outcome.prepared).toBeNull();
    const issues = workloadIssues(outcome);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'error' });
    expect(issues[0]?.message).toContain('"quantum-routing"');
    expect(issues[0]?.message).toContain('supported: teams-authentication');
  });

  it('refuses a JSON bundle that states an unsupported workload, and accepts one that states a supported one', async () => {
    const bundle = bundleOf();
    const unsupported = {
      ...bundle,
      case: { ...(bundle.case as Record<string, unknown>), workload: 'quantum-routing' },
    };

    const refused = await runPipeline({ type: 'bundle', bundle: unsupported }, pipelineEnv());
    expect(refused.preview.ok).toBe(false);
    expect(refused.prepared).toBeNull();
    expect(workloadIssues(refused)[0]?.message).toContain('"quantum-routing"');

    const accepted = await runPipeline({ type: 'bundle', bundle }, pipelineEnv());
    expect(accepted.preview.ok).toBe(true);
    expect(workloadIssues(accepted)).toEqual([]);
  });

  it('keeps the parser default for an uploaded CSV file, which cannot state a workload, and says it was assumed', async () => {
    const csv = findExample('events-teams-signin-proxy');
    const outcome = await runPipeline(
      { type: 'file', file: uploadOf('events.csv', csv?.text ?? '', 'text/csv') },
      pipelineEnv(),
    );

    expect(outcome.preview).toMatchObject({
      ok: true,
      summary: { workload: 'teams-authentication' },
    });
    expect(workloadIssues(outcome)).toEqual([]);
    expect(mentionsAssumption(outcome)).toBe(true);
  });
});
