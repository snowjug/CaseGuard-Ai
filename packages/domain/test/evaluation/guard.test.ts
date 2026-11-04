import { describe, expect, it } from 'vitest';
import { checkDataset, independenceSources } from './check';
import {
  loadDataset,
  loadVocabulary,
  readLockedRuns,
  testSetHash,
  type Dataset,
  type LoadedCase,
} from './dataset';
import { evalCase, evalEvent } from './fixtures';
import {
  describeOverlap,
  findForbiddenReaders,
  findOverlaps,
  readerViolation,
  shingles,
  wordsOf,
  type OverlapSource,
} from './guard';
import { appendRun, lockProblems, verifyChain } from './locked';
import { buildManifest, verifyManifest } from './manifest';
import { EVAL_LOCKED_RUNS_SCHEMA, EVAL_MANIFEST_SCHEMA, SPLITS, type LockedRuns } from './schema';

/**
 * Guards over the real dataset. They run in CI, they never run the engine, and they fail the day the corpus stops being
 * independent of what it measures, or the locked test split is touched.
 */
const dataset = loadDataset();

describe('the evaluation dataset', () => {
  it('loads, and every file matches its schema', () => {
    expect(dataset.problems).toEqual([]);
    expect(dataset.cases.length).toBeGreaterThan(0);
  });

  it('matches its manifest: every case and annotation file hash, no case in two splits, every family in one split', () => {
    expect(verifyManifest(dataset)).toEqual([]);
    const ids = dataset.cases.map((loaded) => loaded.case.id);
    expect(new Set(ids).size).toBe(ids.length);
    const splitsOfFamily = new Map<string, Set<string>>();
    for (const { case: entry } of dataset.cases) {
      splitsOfFamily.set(
        entry.family,
        (splitsOfFamily.get(entry.family) ?? new Set<string>()).add(entry.split),
      );
    }
    const split = [...splitsOfFamily]
      .filter(([, splits]) => splits.size > 1)
      .map(([family]) => family);
    expect(split).toEqual([]);
  });

  it('passes the structural check: vocabulary ids, event keys, annotators, derived copies and categories', () => {
    const result = checkDataset(dataset, loadVocabulary(), { overlaps: false });
    expect(result.errors).toEqual([]);
  });

  it('shares no six-word run with the shipped samples, the vocabulary, the knowledge pack, the detector tests or another split', () => {
    const found = findOverlaps(
      dataset.cases.map((loaded) => loaded.case),
      independenceSources(dataset),
    );
    expect(found.map(describeOverlap)).toEqual([]);
  });

  it('is read by nothing but the evaluation tooling and the guard: not the engine source, not a detector test', () => {
    expect(findForbiddenReaders()).toEqual([]);
  });

  it('has an append-only log of locked runs that all ran the set that was locked', () => {
    const log = readLockedRuns() ?? { schema: EVAL_LOCKED_RUNS_SCHEMA, runs: [] };
    expect(verifyChain(log, dataset.manifest?.locked?.testSetSha256 ?? null)).toEqual([]);
  });
});

describe('the overlap guard', () => {
  const source = (
    kind: OverlapSource['kind'],
    text: string,
    name = `a ${kind}`,
  ): OverlapSource => ({
    kind,
    name,
    shingles: shingles(wordsOf(text)),
  });
  const copied = evalCase({
    events: [
      evalEvent(
        'ev01',
        0,
        'customer',
        'Everyone in the Gdansk office lost the connection at nine this morning.',
      ),
    ],
  });

  it('reads words the way a person does: case and dots around a word do not matter, dots inside one do', () => {
    expect(wordsOf('Sign-in FAILED. See a.kowal at 10.20.1.10!')).toEqual([
      'sign',
      'in',
      'failed',
      'see',
      'a.kowal',
      'at',
      '10.20.1.10',
    ]);
  });

  it('flags six shared words and shows the phrase only for a source that may be shown', () => {
    const phrase = 'the Gdansk office lost the connection';
    const [sample] = findOverlaps(
      [copied],
      [source('shipped-sample', `Reported: ${phrase} twice.`)],
    );
    expect(sample).toMatchObject({
      caseId: copied.id,
      where: 'ev01',
      source: 'shipped-sample',
      phrase: 'the gdansk office lost the connection',
    });
    const [pack] = findOverlaps([copied], [source('knowledge-pack', phrase)]);
    expect(pack?.phrase).toBeNull();
    expect(describeOverlap(pack as NonNullable<typeof pack>)).toContain('phrase withheld');
  });

  it('lets five shared words pass, and does not compare a case with its own split', () => {
    expect(findOverlaps([copied], [source('vocabulary', 'the Gdansk office lost the')])).toEqual(
      [],
    );
    expect(
      findOverlaps(
        [copied],
        [source('other-split', 'lost the connection at nine this morning', 'dev:')],
      ),
    ).toEqual([]);
    expect(
      findOverlaps(
        [copied],
        [source('other-split', 'lost the connection at nine this morning', 'validation:')],
      ),
    ).toHaveLength(1);
  });
  it('lets a dev case quote a detector test, and refuses it for validation and test', () => {
    const detectorTest: OverlapSource = {
      ...source('detector-test', 'the Gdansk office lost the connection'),
      exceptSplits: ['dev'],
    };
    expect(findOverlaps([evalCase({ ...copied, split: 'dev' })], [detectorTest])).toEqual([]);
    for (const split of ['validation', 'test'] as const) {
      const found = findOverlaps([evalCase({ ...copied, split })], [detectorTest]);
      expect(found, split).toHaveLength(1);
      expect(found[0]?.source).toBe('detector-test');
    }
  });

  it('exempts only dev from the detector tests, in the source the check really uses', () => {
    const real = independenceSources(dataset);
    expect(real.find((entry) => entry.kind === 'detector-test')?.exceptSplits).toEqual(['dev']);
    for (const entry of real.filter((item) => item.kind !== 'detector-test'))
      expect(entry.exceptSplits ?? [], entry.kind).toEqual([]);
  });
});

describe('who may read the cases', () => {
  it('lets the engine source know nothing of the evaluation, and keeps other code away from validation, test and the loaders', () => {
    expect(
      readerViolation('packages/domain/src/engine/x.ts', "const dir = 'evaluation/cases/dev';"),
    ).not.toBeNull();
    expect(readerViolation('packages/domain/src/engine/x.ts', 'const pattern = /a|b/;')).toBeNull();
    expect(
      readerViolation(
        'packages/domain/test/signals.test.ts',
        "readFileSync('evaluation/cases/validation/x.json')",
      ),
    ).not.toBeNull();
    expect(
      readerViolation(
        'packages/domain/test/signals.test.ts',
        "import { loadDataset } from './evaluation/dataset';",
      ),
    ).not.toBeNull();
    expect(
      readerViolation(
        'packages/domain/test/signals.test.ts',
        "readFileSync('evaluation/annotations/x.json')",
      ),
    ).not.toBeNull();
    expect(
      readerViolation(
        'packages/domain/test/signals.test.ts',
        "import { prepareBundle } from './helpers';",
      ),
    ).toBeNull();
  });
});

describe('the log of locked runs', () => {
  const body = {
    ranAt: '2026-11-10T10:00:00Z',
    gitCommit: 'a'.repeat(40),
    engineVersion: '@caseguard/domain@0.1.0',
    packId: 'kp.teams-authentication',
    packVersion: '1.0.0',
    packSha256: 'b'.repeat(64),
    caseSetSha256: 'c'.repeat(64),
    testSetSha256: 'd'.repeat(64),
    resultsSha256: 'e'.repeat(64),
    detail: false,
  };
  const empty: LockedRuns = { schema: EVAL_LOCKED_RUNS_SCHEMA, runs: [] };

  it('chains every record to the one before it, so that an edit or a removal shows', () => {
    const twice = appendRun(appendRun(empty, body), { ...body, resultsSha256: 'f'.repeat(64) });
    expect(twice.runs.map((run) => run.index)).toEqual([1, 2]);
    expect(twice.runs[1]?.previous).toBe(twice.runs[0]?.hash);
    expect(verifyChain(twice, body.testSetSha256)).toEqual([]);
    const edited: LockedRuns = {
      ...twice,
      runs: [{ ...twice.runs[0]!, resultsSha256: '0'.repeat(64) }, twice.runs[1]!],
    };
    expect(verifyChain(edited, null).length).toBeGreaterThan(0);
    const removed: LockedRuns = { ...twice, runs: [twice.runs[1]!] };
    expect(verifyChain(removed, null).length).toBeGreaterThan(0);
  });

  it('rejects a record that ran another set than the one that was locked', () => {
    const log = appendRun(empty, body);
    expect(verifyChain(log, 'z'.repeat(64)).join(' ')).toMatch(/other than the locked one/);
  });
});

describe('the manifest of a locked set', () => {
  const loaded = (id: string, split: 'dev' | 'test', hash: string): LoadedCase => ({
    case: evalCase({ id, split, family: `fam-${id.slice(5, 8)}` }),
    caseFile: `cases/${split}/${id}.json`,
    eventsSha256: hash.repeat(64),
    annotations: null,
    annotationsFile: `annotations/${id}.json`,
    annotationsSha256: 'a'.repeat(64),
  });
  const build = (cases: LoadedCase[]): Dataset => ({
    root: '',
    cases,
    annotators: null,
    manifest: null,
    problems: [],
  });

  it('refuses to be rewritten once the test split has changed, and does not lock twice', () => {
    const first = build([loaded('ev-d-001-one', 'dev', 'b'), loaded('ev-t-001-two', 'test', 'c')]);
    const locked = buildManifest(first, null, {
      at: '2026-11-10T10:00:00Z',
      commit: 'a'.repeat(40),
    });
    expect(locked.locked?.testSetSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(locked.schema).toBe(EVAL_MANIFEST_SCHEMA);
    expect(Object.keys(locked.splits)).toEqual([...SPLITS]);
    const changed = build([
      loaded('ev-d-001-one', 'dev', 'b'),
      loaded('ev-t-001-two', 'test', 'd'),
    ]);
    expect(() => buildManifest(changed, locked, null)).toThrow(/locked test split has changed/);
    expect(() =>
      buildManifest(first, locked, { at: '2026-11-11T10:00:00Z', commit: 'a'.repeat(40) }),
    ).toThrow(/already locked/);
    // A change to the dev split is allowed, and bumps the annotation version only when an annotation file changed.
    const devChanged = build([
      { ...loaded('ev-d-001-one', 'dev', 'e'), annotationsSha256: 'f'.repeat(64) },
      loaded('ev-t-001-two', 'test', 'c'),
    ]);
    expect(buildManifest(devChanged, locked, null).annotationVersion).toBe(
      locked.annotationVersion + 1,
    );
  });

  it('reports a case file or an annotation file that no longer matches its hash', () => {
    const files = build([loaded('ev-d-001-one', 'dev', 'b')]);
    const manifest = buildManifest(files, null, null);
    expect(verifyManifest({ ...files, manifest })).toEqual([]);
    const drifted = build([
      {
        ...loaded('ev-d-001-one', 'dev', 'b'),
        eventsSha256: 'c'.repeat(64),
        annotationsSha256: 'd'.repeat(64),
      },
    ]);
    const problems = verifyManifest({ ...drifted, manifest });
    expect(problems.join('\n')).toMatch(/case file does not match/);
    expect(problems.join('\n')).toMatch(/annotation file does not match/);
  });

  it('is run only once it is locked, committed and unchanged, and the log of earlier runs is sound', () => {
    const files = build([loaded('ev-d-001-one', 'dev', 'b'), loaded('ev-t-001-two', 'test', 'c')]);
    const testHash = testSetHash(files.cases.filter((entry) => entry.case.split === 'test'));
    const empty: LockedRuns = { schema: EVAL_LOCKED_RUNS_SCHEMA, runs: [] };
    const unlocked = buildManifest(files, null, null);
    expect(lockProblems({ manifest: unlocked, uncommitted: [], testHash, log: empty })[0]).toMatch(
      /not locked yet/,
    );
    const locked = buildManifest(files, null, {
      at: '2026-11-10T10:00:00Z',
      commit: 'a'.repeat(40),
    });
    expect(lockProblems({ manifest: locked, uncommitted: [], testHash, log: empty })).toEqual([]);
    const dirty = lockProblems({
      manifest: locked,
      uncommitted: [' M evaluation/cases/test/ev-t-001-two.json'],
      testHash,
      log: empty,
    });
    expect(dirty.join(' ')).toMatch(/Uncommitted changes/);
    const changed = lockProblems({
      manifest: locked,
      uncommitted: [],
      testHash: 'z'.repeat(64),
      log: empty,
    });
    expect(changed.join(' ')).toMatch(/differs from the one that was locked/);
    const other = appendRun(empty, {
      ranAt: '2026-11-10T10:00:00Z',
      gitCommit: 'a'.repeat(40),
      engineVersion: '2026.3.1 (@caseguard/domain@0.1.0)',
      packId: 'kp.teams-authentication',
      packVersion: '1.0.0',
      packSha256: 'b'.repeat(64),
      caseSetSha256: 'c'.repeat(64),
      testSetSha256: 'z'.repeat(64),
      resultsSha256: 'e'.repeat(64),
      detail: false,
    });
    expect(
      lockProblems({ manifest: locked, uncommitted: [], testHash, log: other }).join(' '),
    ).toMatch(/log of locked runs is broken/);
  });
});
