import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { format, resolveConfig } from 'prettier';
import { describe, expect, it } from 'vitest';
import { SAMPLES_OUTPUT, exportSamples, planSamplesFile } from '../../../scripts/export-samples';

const repoRoot = resolve(import.meta.dirname, '../../..');

describe('scripts/export-samples.ts', () => {
  it('[FR-ING-09] plans the generated module in the samples folder and is deterministic', async () => {
    const first = await planSamplesFile();
    const second = await planSamplesFile();
    expect(first.path).toBe('apps/api/src/samples/generated.ts');
    expect(SAMPLES_OUTPUT).toBe(first.path);
    expect(second).toEqual(first);
    expect(first.content.endsWith('\n')).toBe(true);
    expect(first.content).toContain('GENERATED FILE. Do not edit by hand.');
  });

  it('[FR-ING-09] output is already formatted the way Prettier formats it', async () => {
    const file = await planSamplesFile();
    const config = await resolveConfig(resolve(repoRoot, file.path));
    expect(await format(file.content, { ...config, parser: 'typescript' })).toBe(file.content);
  });

  it('[FR-ING-09] the committed generated.ts is in sync with synthetic-data (run "pnpm samples:export" if this fails)', async () => {
    const file = await planSamplesFile();
    const onDisk = readFileSync(resolve(repoRoot, file.path), 'utf8').replace(/\r\n/g, '\n');
    expect(onDisk, `${file.path} is out of date`).toBe(file.content);

    const result = await exportSamples({ check: true });
    expect(result.stale).toEqual([]);
    expect(result.written).toEqual([]);
    expect(result.unchanged).toEqual([file.path]);
  });

  it('[FR-ING-09] the CLI runs and its --check mode passes on the committed file', () => {
    const output = execFileSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/export-samples.ts', '--check'],
      { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 },
    );
    expect(output).toContain('The embedded sample data is up to date.');
  }, 90_000);
});
