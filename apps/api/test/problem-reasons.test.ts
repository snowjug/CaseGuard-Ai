import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ProblemSchema } from '@caseguard/schemas';
import { describe, expect, it } from 'vitest';

/*
 * The `reason` tokens of Problem Details are a contract: the web app switches on them. docs/API.md lists
 * every token the API sends; this test keeps that list and the code from drifting apart.
 */

const repoRoot = resolve(import.meta.dirname, '../../..');
const SOURCE_DIRECTORIES = ['apps/api/src', 'packages/security/src'];

function sourceFiles(directory: string): string[] {
  return readdirSync(join(repoRoot, directory), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name));
}

const code = SOURCE_DIRECTORIES.flatMap(sourceFiles)
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');

function documentedTokens(): string[] {
  const page = readFileSync(join(repoRoot, 'docs/API.md'), 'utf8').replace(/\r\n/g, '\n');
  const start = page.indexOf('#### Reason tokens');
  expect(start, 'docs/API.md has a "Reason tokens" section').toBeGreaterThan(-1);
  const end = page.indexOf('\n### ', start);
  const rows = page
    .slice(start, end === -1 ? undefined : end)
    .split('\n')
    .filter((line) => line.startsWith('| `'));
  return rows.flatMap((row) =>
    [...(row.split('|')[1] ?? '').matchAll(/`([a-z][a-z0-9_]*)`/g)].map((match) => match[1] ?? ''),
  );
}

describe('Problem Details reason tokens', () => {
  const documented = documentedTokens();

  it('are listed once each in docs/API.md and are valid tokens', () => {
    expect(documented.length).toBeGreaterThan(10);
    expect(new Set(documented).size).toBe(documented.length);
    for (const token of documented) {
      const problem = ProblemSchema.safeParse({
        type: 'urn:caseguard:problem:conflict',
        title: 'Conflict',
        status: 409,
        code: 'conflict',
        reason: token,
      });
      expect(problem.success, token).toBe(true);
    }
  });

  it('include every token the code attaches to an error', () => {
    const attached = new Set(
      [...code.matchAll(/\breason:\s*'([a-z][a-z0-9_]{2,39})'/g)].map((match) => match[1] ?? ''),
    );
    expect(attached.size).toBeGreaterThan(10);
    expect([...attached].filter((token) => !documented.includes(token))).toEqual([]);
  });

  it('name nothing the code no longer sends', () => {
    expect(documented.filter((token) => !code.includes(`'${token}'`))).toEqual([]);
  });
});
