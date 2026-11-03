import { describe, expect, it } from 'vitest';
import { acceptLabels, acceptedFor } from './labels';
import type { Dataset, LoadedCase } from './dataset';
import { evalCase } from './fixtures';
import {
  EVAL_ANNOTATIONS_SCHEMA,
  type Adjudication,
  type AnnotationFile,
  type AnnotationRecord,
} from './schema';

const record = (
  annotatorId: string,
  overrides: Partial<AnnotationRecord> = {},
): AnnotationRecord => ({
  annotatorId,
  kind: 'ai_draft',
  version: 1,
  annotatedAt: '2026-11-01T10:00:00Z',
  excluded: false,
  exclusionReason: null,
  signals: [{ event: 'ev01', id: 'sig.error-timeout' }],
  rationale: 'A made-up rationale.',
  uncertainty: 'none',
  ...overrides,
});

const file = (
  annotations: AnnotationRecord[],
  adjudication: Adjudication | null = null,
): AnnotationFile => ({
  schema: EVAL_ANNOTATIONS_SCHEMA,
  caseId: 'ev-d-901-made-up',
  annotations,
  adjudication,
});

const decision = (overrides: Partial<Adjudication> = {}): Adjudication => ({
  status: 'adjudicated',
  acceptedFrom: 'b',
  decidedBy: 'a reviewer',
  decidedAt: '2026-11-02T10:00:00Z',
  version: 1,
  disagreements: [],
  ...overrides,
});

describe('which labels count as the reference', () => {
  it('takes the only annotation of a case as it is, and keeps a kind that was not annotated as not annotated', () => {
    const accepted = acceptLabels(file([record('a', { earliestMissed: null })]));
    expect(accepted.status).toBe('single_annotator');
    expect(accepted.labels?.signals).toHaveLength(1);
    expect(accepted.labels?.earliestMissed).toBeNull();
    expect(accepted.labels?.actions).toBeUndefined();
    expect(accepted.labels?.forks).toBeUndefined();
  });

  it('reads the latest version of an annotator, and treats an excluded record as excluded', () => {
    const accepted = acceptLabels(file([record('a'), record('a', { version: 2, signals: [] })]));
    expect(accepted.labels?.signals).toEqual([]);
    const excluded = acceptLabels(
      file([record('a', { excluded: true, exclusionReason: 'unreadable' })]),
    );
    expect(excluded).toMatchObject({ status: 'excluded', labels: null, note: 'unreadable' });
  });

  it('does not count a case with two annotators and no decision', () => {
    const accepted = acceptLabels(file([record('a'), record('b')]));
    expect(accepted).toMatchObject({
      status: 'unadjudicated',
      labels: null,
      annotators: ['a', 'b'],
    });
  });

  it('builds the accepted labels of an adjudicated case from the chosen record and the values accepted per field', () => {
    const accepted = acceptLabels(
      file(
        [
          record('a', { earliestMissed: 'ev02' }),
          record('b', { earliestMissed: null, causes: ['hyp.dns-resolution'] }),
        ],
        decision({
          disagreements: [
            {
              field: 'signals',
              values: { a: [], b: [] },
              accepted: [{ event: 'ev03', id: 'sig.prt-missing' }],
              rationale: 'the later message says so',
            },
          ],
        }),
      ),
    );
    expect(accepted.status).toBe('adjudicated');
    expect(accepted.acceptedFrom).toBe('b');
    expect(accepted.labels?.signals).toEqual([{ event: 'ev03', id: 'sig.prt-missing' }]);
    expect(accepted.labels?.earliestMissed).toBeNull();
    expect(accepted.labels?.causes).toEqual(['hyp.dns-resolution']);
    expect(
      acceptLabels(file([record('a'), record('b')], decision({ status: 'agreed' }))).status,
    ).toBe('agreed');
  });

  it('drops a decision that is older than a record, and refuses an accepted value that is not a label', () => {
    const newer = record('b', { annotatedAt: '2026-11-03T10:00:00Z' });
    expect(acceptLabels(file([record('a'), newer], decision())).status).toBe('unadjudicated');
    const bad = decision({
      disagreements: [{ field: 'signals', values: {}, accepted: 'not a list', rationale: 'x' }],
    });
    expect(() => acceptLabels(file([record('a'), record('b')], bad))).toThrow(/signals/);
    expect(
      acceptLabels(file([record('a'), record('b')], decision({ status: 'excluded' }))).status,
    ).toBe('excluded');
  });

  it('gives a reordered copy the labels of its source, and a case with no annotation file none', () => {
    const source: LoadedCase = {
      case: evalCase({ id: 'ev-d-901-source' }),
      caseFile: 'cases/dev/ev-d-901-source.json',
      eventsSha256: 'x',
      annotations: file([record('a')]),
      annotationsFile: 'annotations/ev-d-901-source.json',
      annotationsSha256: 'y',
    };
    const copy: LoadedCase = {
      ...source,
      case: evalCase({
        id: 'ev-d-902-copy',
        derivedFrom: 'ev-d-901-source',
        handedOverOrder: ['ev02', 'ev01', 'ev03'],
      }),
      annotations: null,
      annotationsFile: null,
      annotationsSha256: null,
    };
    const bare: LoadedCase = { ...copy, case: evalCase({ id: 'ev-d-903-bare' }) };
    const dataset: Dataset = {
      root: '',
      cases: [source, copy, bare],
      annotators: null,
      manifest: null,
      problems: [],
    };
    expect(acceptedFor(dataset, copy)?.status).toBe('single_annotator');
    expect(acceptedFor(dataset, bare)).toBeNull();
  });
});
