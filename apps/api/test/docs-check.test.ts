import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Tests of `scripts/check-docs.mjs` through its command line, on small documentation trees built in the
 * system temp directory. The live repository is deliberately not scanned here: whether today's pages
 * are clean is the job of `pnpm docs:check`, not of a unit test that would fail on someone else's page.
 */

const repoRoot = resolve(import.meta.dirname, '../../..');
const script = join(repoRoot, 'scripts', 'check-docs.mjs');
const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'cg-docs-check-'));
  scratch.push(root);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  return root;
}

function run(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const CLEAN: Record<string, string> = {
  'README.md': [
    '# Project',
    '',
    '![CI](https://github.com/example/repo/actions/workflows/ci.yml/badge.svg)',
    '[Guide](docs/GUIDE.md), [a section](docs/GUIDE.md#second-section), [this page](#project)',
    '![shot](docs/assets/screenshots/home.png)',
    '',
    '```mermaid',
    'flowchart LR',
    '  A --> B',
    '```',
  ].join('\n'),
  'docs/GUIDE.md': '# Guide\n\n## Second section\n\nBack to [the readme](../README.md).\n',
  'docs/assets/screenshots/home.png': 'png',
  '.github/workflows/ci.yml': 'name: ci\n',
};

describe('scripts/check-docs.mjs', () => {
  it('passes its own self-test', () => {
    const result = run('--self-test');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/self-test: (\d+)\/\1 passed/);
  }, 90_000);

  it('accepts a consistent tree and stays quiet with --quiet', () => {
    const root = tree(CLEAN);
    const loud = run('--root', root);
    expect(loud.status).toBe(0);
    expect(loud.stdout).toContain('2 Markdown file(s) checked, no problems');
    const quiet = run('--root', root, '--quiet');
    expect(quiet.status).toBe(0);
    expect(quiet.stdout).toBe('');
  }, 90_000);

  it('reports every rule it has, with file, line and rule name', () => {
    const root = tree({
      'README.md': [
        '# Project',
        '[gone](docs/MISSING.md)',
        '[wrong case](docs/guide.md)',
        '[bad anchor](docs/GUIDE.md#no-such-heading)',
        '[bad local anchor](#no-such-local-heading)',
        '![no image](docs/img/missing.png)',
        '![no screenshot](docs/assets/screenshots/missing.png)',
        '[![CI](https://github.com/example/repo/actions/workflows/absent.yml/badge.svg)](https://example.test)',
        '',
        '```mermaid',
        '```',
        '',
        '```text',
        'a fence that is never closed',
      ].join('\n'),
      'docs/GUIDE.md': '# Guide\n\n```mermaid\nflowchart LR\n  A --> B\n',
      '.github/workflows/ci.yml': 'name: ci\n',
    });
    const result = run('--root', root);
    expect(result.status).toBe(1);
    for (const [file, rule] of [
      ['README.md', 'link-missing'],
      ['README.md', 'anchor-missing'],
      ['README.md', 'image-missing'],
      ['README.md', 'screenshot-missing'],
      ['README.md', 'badge-workflow-missing'],
      ['README.md', 'mermaid-empty'],
      ['README.md', 'fence-unterminated'],
      ['docs/GUIDE.md', 'mermaid-unterminated'],
    ] as const) {
      expect(result.stderr, `${file} should report ${rule}`).toMatch(
        new RegExp(`^${file.replace('/', '\\/')}:\\d+: \\[${rule}\\]`, 'm'),
      );
    }
    expect(result.stderr).toMatch(/README\.md:2: \[link-missing\]/);
    expect(result.stderr).toMatch(/README\.md:3: \[link-missing\]/);
    expect(result.stderr).toMatch(/README\.md:4: \[anchor-missing\]/);
    expect(result.stderr).toMatch(/README\.md:5: \[anchor-missing\]/);
    expect(result.stderr).toMatch(/check-docs: 10 problem\(s\) in 2 Markdown file\(s\)/);
  }, 90_000);

  it('reports a FILL placeholder left in a page, wherever it hides, without repeating it', () => {
    const unfilled = ['<<', 'FILL FROM FINAL_VALIDATION', '>>'].join('');
    const root = tree({
      'README.md': [
        '# Project',
        `| Unit tests | ${unfilled} |`,
        `In a code span: \`${unfilled}\``,
        `<!-- ${unfilled} -->`,
        '[OWNER TO FILL IN the contact] is an owner action, not a placeholder.',
      ].join('\n'),
    });
    const result = run('--root', root);
    expect(result.status).toBe(1);
    for (const line of [2, 3, 4]) {
      expect(result.stderr).toMatch(
        new RegExp(`^README\\.md:${line}: \\[placeholder-unfilled\\]`, 'm'),
      );
    }
    expect(result.stderr).not.toMatch(/README\.md:5:/);
    // The report is copied into validation reports, so it must not trip the rule on the next run.
    expect(result.stderr).not.toContain('FINAL_VALIDATION');
    expect(result.stderr).toMatch(/check-docs: 3 problem\(s\) in 1 Markdown file\(s\)/);
  }, 90_000);

  it('ignores code spans, fenced code, HTML comments and external links', () => {
    const root = tree({
      'README.md': [
        '# Project',
        'A code span `[x](docs/NOPE.md)` and a comment <!-- [y](docs/NOPE.md) --> are not links.',
        '',
        '```md',
        '[z](docs/NOPE.md)',
        '```',
        '',
        '[outside](https://example.test/docs/NOPE.md) and [mail](mailto:someone@example.test).',
      ].join('\n'),
    });
    expect(run('--root', root).status).toBe(0);
  }, 90_000);

  it('does not scan node_modules or other generated directories', () => {
    const root = tree({
      'README.md': '# Project\n',
      'node_modules/pkg/README.md': '[broken](./nowhere.md)\n',
      '.next/server/page.md': '[broken](./nowhere.md)\n',
    });
    const result = run('--root', root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('1 Markdown file(s) checked');
  }, 90_000);

  it('uses GitHub heading slugs, including the numbering of repeated headings', () => {
    const root = tree({
      'README.md': [
        '# Title',
        '[first](#notes), [second](#notes-1), [code](#the-run-command), [dots](#31-parts)',
        '',
        '## Notes',
        '## Notes',
        '## The `run` command',
        '### 3.1 Parts',
      ].join('\n'),
    });
    const result = run('--root', root);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  }, 90_000);

  it('answers a usage error with exit code 2 and tolerates the "--" a package manager forwards', () => {
    const root = tree({ 'README.md': '# Project\n' });
    const unknown = run('--frobnicate');
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('Unknown argument "--frobnicate"');
    expect(run('--root').status).toBe(2);
    expect(run('--root', join(root, 'does-not-exist')).status).toBe(2);
    expect(run('--', '--root', root).status).toBe(0);
  }, 90_000);
});
