import { describe, expect, it } from 'vitest';
import { PLACEHOLDER, makeDraft, mergeRecord, registerAnnotator } from './annotate';
import { compareAnnotators, renderAgreement, type AgreementCase } from './agreement';
import { evalCase } from './fixtures';
import { AnnotationDraftSchema, EVAL_ANNOTATIONS_SCHEMA, type AnnotationRecord } from './schema';

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
  signals: [],
  rationale: 'A made-up rationale.',
  uncertainty: 'none',
  ...overrides,
});

describe('the template for a second annotator', () => {
  it('is an empty record that holds no label and still has to be filled in', () => {
    const draft = makeDraft(evalCase(), 'second-reader', 'ai_draft', '2026-11-03T10:00:00Z');
    expect(AnnotationDraftSchema.safeParse(draft).success).toBe(true);
    expect(draft.record).toMatchObject({
      annotatorId: 'second-reader',
      kind: 'ai_draft',
      version: 1,
      signals: [],
      absent: [],
      forks: [],
      causes: [],
    });
    expect(JSON.stringify(draft)).toContain(PLACEHOLDER);
  });

  it('is merged next to the first annotator without touching it, and never twice for one version', () => {
    const first = record('first');
    const created = mergeRecord(null, 'ev-d-901-made-up', first);
    expect(created).toMatchObject({
      schema: EVAL_ANNOTATIONS_SCHEMA,
      caseId: 'ev-d-901-made-up',
      adjudication: null,
    });
    const merged = mergeRecord(created, 'ev-d-901-made-up', record('second'));
    expect(merged.annotations.map((entry) => entry.annotatorId)).toEqual(['first', 'second']);
    expect(created.annotations).toHaveLength(1);
    expect(() => mergeRecord(merged, 'ev-d-901-made-up', record('second'))).toThrow(
      /already has a record of version 1/,
    );
    expect(
      mergeRecord(merged, 'ev-d-901-made-up', record('second', { version: 2 })).annotations,
    ).toHaveLength(3);
  });

  it('registers an annotator once', () => {
    const registry = registerAnnotator(
      null,
      'second-reader',
      'human',
      'A person.',
      '2026-11-03T10:00:00Z',
    );
    expect(
      registerAnnotator(registry, 'second-reader', 'ai_draft', 'Other.', '2026-11-04T10:00:00Z'),
    ).toBe(registry);
    expect(registry.annotators).toEqual([
      {
        id: 'second-reader',
        kind: 'human',
        description: 'A person.',
        addedAt: '2026-11-03T10:00:00Z',
      },
    ]);
  });
});

describe('agreement between two annotators', () => {
  const vocabulary = {
    signals: ['sig.s1', 'sig.s2', 'sig.s3'].map((id) => ({
      id,
      label: id,
      description: id,
      dimension: 'scope',
      kind: 'presence' as const,
    })),
    actions: ['act.a1', 'act.a2'].map((id) => ({
      id,
      label: id,
      description: id,
      executor: 'engineer',
    })),
    hypotheses: ['hyp.h1', 'hyp.h2', 'hyp.other'].map((id) => ({ id, name: id, description: id })),
    forkCategories: [{ id: 'low_value_action', label: 'x' }],
  };
  const events = [
    { key: 'ev01', who: 'customer' },
    { key: 'ev02', who: 'engineer' },
    { key: 'ev03', who: 'customer' },
    { key: 'ev04', who: 'engineer' },
  ] as const;

  const first: AgreementCase = {
    caseId: 'ev-d-901-first',
    events,
    a: record('a', {
      signals: [
        { event: 'ev01', id: 'sig.s1' },
        { event: 'ev03', id: 'sig.s2' },
      ],
      actions: [{ event: 'ev02', id: 'act.a1' }],
      earliestMissed: 'ev02',
      causes: ['hyp.h1'],
    }),
    b: record('b', {
      signals: [
        { event: 'ev01', id: 'sig.s1' },
        { event: 'ev02', id: 'sig.s3' },
      ],
      actions: [
        { event: 'ev02', id: 'act.a1' },
        { event: 'ev04', id: 'act.a2' },
      ],
      earliestMissed: 'ev02',
      causes: ['hyp.h1'],
    }),
  };
  const second: AgreementCase = {
    caseId: 'ev-d-901-second',
    events,
    a: record('a', { earliestMissed: 'ev02', causes: ['hyp.h1'] }),
    b: record('b', { earliestMissed: null, causes: ['hyp.h2'] }),
  };

  it('computes kappa per kind of label over the decisions each kind is made on', () => {
    const report = compareAnnotators('a', 'b', [first], vocabulary);
    const signals = report.kinds.find((entry) => entry.kind === 'signals');
    // 12 decisions (4 events x 3 signals): one both say yes to, one only a, one only b, nine neither.
    expect(signals?.agreement).toMatchObject({ n: 12, bothYes: 1, onlyA: 1, onlyB: 1, bothNo: 9 });
    expect(signals?.agreement.kappa).toBeCloseTo(0.4, 6);
    expect(report.kinds.find((entry) => entry.kind === 'actions')?.agreement.kappa).toBeCloseTo(
      0.5,
      6,
    );
    expect(
      report.kinds.find((entry) => entry.kind === 'earliestMissed')?.agreement.kappa,
    ).toBeNull();
  });

  it('lists the disagreements to adjudicate, and leaves out a kind that only one annotator annotated', () => {
    const report = compareAnnotators('a', 'b', [first, second], vocabulary);
    expect(report.disagreements).toContainEqual({
      caseId: 'ev-d-901-first',
      kind: 'signals',
      item: 'ev03|sig.s2',
      a: 'present',
      b: 'absent',
    });
    expect(report.disagreements).toContainEqual({
      caseId: 'ev-d-901-second',
      kind: 'earliestMissed',
      item: 'the case',
      a: 'ev02',
      b: 'none',
    });
    expect(report.kinds.find((entry) => entry.kind === 'earliestMissed')?.agreement.kappa).toBe(0);
    expect(report.kinds.find((entry) => entry.kind === 'causes')?.agreement.kappa).toBeCloseTo(
      0,
      6,
    );
    expect(report.kinds.some((entry) => entry.kind === 'qualityBand')).toBe(false);
    const text = renderAgreement(report);
    expect(text).toContain('Disagreements to adjudicate');
    expect(text).toContain('not a human reference');
  });
});
