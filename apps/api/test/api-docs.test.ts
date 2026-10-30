import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ROUTES, type RouteId } from '@caseguard/schemas';
import { format, resolveConfig } from 'prettier';
import { afterAll, describe, expect, it } from 'vitest';
import {
  API_DOC_PATH,
  BEGIN_MARKER,
  END_MARKER,
  MarkerError,
  PERMISSION_NOTES,
  exportApiDocs,
  fieldNames,
  insertRouteReference,
  planApiDocs,
  renderRouteReference,
  routeEntries,
} from '../../../scripts/export-api-docs';
import { HEAVY_ROUTES } from '../src/http/route-binder';

const repoRoot = resolve(import.meta.dirname, '../../..');
const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A throw-away copy of docs/API.md in the system temp directory, never inside the repository. */
function tempRoot(content: string): string {
  const root = mkdtempSync(join(tmpdir(), 'cg-api-docs-'));
  scratch.push(root);
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, API_DOC_PATH), content, 'utf8');
  return root;
}

/** The page with a stale generated header: the route count is wrong, nothing else changed. */
const drift = (page: string): string => page.replace(/^\d+ routes \(/m, '1 routes (');

const rowIds = (markdown: string): string[] =>
  [...markdown.matchAll(/^\| `([A-Za-z.]+)` \|/gm)].map((match) => match[1] ?? '');

describe('scripts/export-api-docs.ts', () => {
  it('lists every route of the registry exactly once, grouped by first tag in registry order', () => {
    const reference = renderRouteReference();
    const groups = [...new Set(routeEntries().map((entry) => entry.spec.tags[0]))];
    const expected = groups.flatMap((group) =>
      routeEntries()
        .filter((entry) => entry.spec.tags[0] === group)
        .map((entry) => entry.id),
    );
    expect(rowIds(reference)).toEqual(expected);
    expect([...rowIds(reference)].sort()).toEqual(Object.keys(ROUTES).sort());
    expect(reference).toContain(`${Object.keys(ROUTES).length} routes (`);
    expect(reference).toContain('generated from `ROUTES` in `packages/schemas/src/api.ts`');
  });

  it('groups routes by their first tag and writes one table per group', () => {
    const reference = renderRouteReference();
    const groups = [...new Set(routeEntries().map((entry) => entry.spec.tags[0]))];
    const headings = [...reference.matchAll(/^### (.+)$/gm)].map((match) => match[1]);
    expect(headings).toEqual(groups);
    expect(reference.match(/^\| Route id \|/gm)).toHaveLength(groups.length);
  });

  it('marks fields that may be left out and keeps a required z.unknown() field required', () => {
    expect(fieldNames(ROUTES['cases.list'].query)).toEqual([
      'limit?',
      'cursor?',
      'status?',
      'workload?',
      'analysisState?',
      'q?',
    ]);
    expect(fieldNames(ROUTES['analysis.start'].body)).toEqual(['force?']);
    expect(fieldNames(ROUTES['governance.update'].body)).toContain('value');
    expect(fieldNames(ROUTES['governance.update'].body)).not.toContain('value?');
    expect(fieldNames(undefined)).toBeNull();
    expect(fieldNames(ROUTES['schemas.caseBundle'].response)).toBeNull();
  });

  it('describes idempotent, job-returning and multipart routes', () => {
    const rows = new Map(
      renderRouteReference()
        .split('\n')
        .filter((line) => line.startsWith('| `'))
        .map((line) => [/^\| `([A-Za-z.]+)`/.exec(line)?.[1] ?? '', line] as const),
    );
    expect(rows.get('analysis.start')).toContain('| 202, job, idempotent |');
    expect(rows.get('cases.create')).toContain('| 201, idempotent |');
    expect(rows.get('cases.createFromFile')).toContain('multipart: `file`');
    expect(rows.get('cases.list')).toContain('| 200 |');
    expect(rows.get('demo.reset')).toContain('`demo:manage`');
  });

  it('has a permission note for exactly the routes that declare no permission', () => {
    const open = routeEntries()
      .filter((entry) => entry.spec.permission === null)
      .map((entry) => entry.id)
      .sort();
    expect(Object.keys(PERMISSION_NOTES).sort()).toEqual(open);
    const registry = { ...ROUTES, 'test.open': { ...ROUTES['session.me'] } };
    expect(() => renderRouteReference(registry)).toThrow(/test\.open/);
  });

  it('replaces only the text between the markers, and does so idempotently', () => {
    const page = `# Title\n\nbefore\n\n${BEGIN_MARKER}\nold table\n${END_MARKER}\n\nafter\n`;
    const once = insertRouteReference(page, 'NEW\n');
    expect(once).toContain('before');
    expect(once).toContain('after');
    expect(once).not.toContain('old table');
    expect(once).toContain(`${BEGIN_MARKER}\n\nNEW\n\n${END_MARKER}`);
    expect(insertRouteReference(once, 'NEW\n')).toBe(once);
  });

  it('refuses a page whose markers are missing, duplicated or reversed', () => {
    expect(() => insertRouteReference('# nothing', 'x')).toThrow(MarkerError);
    expect(() => insertRouteReference(`${BEGIN_MARKER}\n`, 'x')).toThrow(MarkerError);
    expect(() => insertRouteReference(`${BEGIN_MARKER}${BEGIN_MARKER}${END_MARKER}`, 'x')).toThrow(
      MarkerError,
    );
    expect(() => insertRouteReference(`${END_MARKER}\n${BEGIN_MARKER}`, 'x')).toThrow(
      /END marker comes before/,
    );
  });

  it('plans deterministic output that Prettier would not change', async () => {
    const first = await planApiDocs();
    const second = await planApiDocs();
    expect(second).toEqual(first);
    expect(first.path).toBe(API_DOC_PATH);
    expect(first.content.endsWith('\n')).toBe(true);
    const config = await resolveConfig(resolve(repoRoot, first.path));
    expect(await format(first.content, { ...config, parser: 'markdown' })).toBe(first.content);
  });

  it('the committed docs/API.md is in sync with the registry (run "pnpm docs:api" if this fails)', async () => {
    const file = await planApiDocs();
    const onDisk = readFileSync(resolve(repoRoot, API_DOC_PATH), 'utf8').replace(/\r\n/g, '\n');
    expect(onDisk, `${API_DOC_PATH} is out of date`).toBe(file.content);
    const result = await exportApiDocs({ check: true });
    expect(result).toEqual({ written: [], unchanged: [API_DOC_PATH], stale: [] });
  });

  it('check mode reports a drifted file and write mode repairs it', async () => {
    const committed = readFileSync(resolve(repoRoot, API_DOC_PATH), 'utf8');
    const drifted = drift(committed);
    expect(drifted).not.toBe(committed);
    const root = tempRoot(drifted);
    expect(await exportApiDocs({ root, check: true })).toEqual({
      written: [],
      unchanged: [],
      stale: [API_DOC_PATH],
    });
    expect((await exportApiDocs({ root })).written).toEqual([API_DOC_PATH]);
    expect((await exportApiDocs({ root, check: true })).stale).toEqual([]);
    // A generated file is never rewritten when nothing changed.
    expect((await exportApiDocs({ root })).unchanged).toEqual([API_DOC_PATH]);
  });

  it('keeps the hand-written text of the page when it regenerates', async () => {
    const committed = readFileSync(resolve(repoRoot, API_DOC_PATH), 'utf8');
    const root = tempRoot(drift(committed));
    expect((await exportApiDocs({ root })).written).toEqual([API_DOC_PATH]);
    const regenerated = readFileSync(join(root, API_DOC_PATH), 'utf8');
    const outside = (text: string): string =>
      `${text.slice(0, text.indexOf(BEGIN_MARKER))}${text.slice(text.indexOf(END_MARKER))}`;
    expect(outside(regenerated)).toBe(outside(committed));
  });

  it('the CLI runs and its --check mode passes on the committed file', () => {
    const output = execFileSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/export-api-docs.ts', '--check'],
      { cwd: repoRoot, encoding: 'utf8', timeout: 90_000 },
    );
    expect(output).toContain('The API reference is up to date');
  }, 120_000);
});

describe('docs/API.md (hand-written parts)', () => {
  const page = readFileSync(resolve(repoRoot, API_DOC_PATH), 'utf8').replace(/\r\n/g, '\n');

  /** The text of one `###` section: from its heading to the next heading of any level. */
  const section = (heading: string): string => {
    const start = page.indexOf(`\n### ${heading}\n`);
    expect(start, `section "${heading}" is missing`).toBeGreaterThan(-1);
    const rest = page.slice(start + 1);
    const next = rest.slice(4).search(/\n#{1,3} /);
    return next === -1 ? rest : rest.slice(0, next + 4);
  };

  it('lists exactly the heavy routes that carry the stricter per-user limit', () => {
    const listed = [...section('Heavy routes').matchAll(/`([A-Za-z.]+)`/g)]
      .map((match) => match[1] ?? '')
      .filter((id): id is RouteId => id in ROUTES);
    expect(new Set(listed)).toEqual(new Set(HEAVY_ROUTES));
  });

  it('names every route that honours an Idempotency-Key', () => {
    const idempotent = routeEntries()
      .filter((entry) => entry.spec.idempotent === true)
      .map((entry) => entry.id);
    const text = section('Idempotency');
    for (const id of idempotent) expect(text, `${id} is not named`).toContain(`\`${id}\``);
  });
});
