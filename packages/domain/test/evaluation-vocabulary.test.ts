import { describe, expect, it } from 'vitest';
import { TEAMS_AUTH_PACK } from '../src/knowledge';
import {
  EVAL_DIMENSIONS,
  SIGNAL_DIMENSIONS,
  buildVocabulary,
  readCommittedVocabulary,
  serializeVocabulary,
} from './evaluation/vocabulary';

const ALLOWED_KEYS = new Set([
  'schema',
  'workload',
  'packId',
  'packVersion',
  'dimensions',
  'signals',
  'actions',
  'requirements',
  'hypotheses',
  'forkCategories',
  'conflictClasses',
  'modalities',
  'absentReasons',
  'id',
  'label',
  'name',
  'description',
  'dimension',
  'kind',
  'valueClass',
  'executor',
  'category',
]);

function collect(value: unknown, keys: Set<string>, strings: string[]): void {
  if (typeof value === 'string') strings.push(value);
  else if (Array.isArray(value)) for (const item of value) collect(item, keys, strings);
  else if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      keys.add(key);
      collect(inner, keys, strings);
    }
  }
}

describe('evaluation vocabulary', () => {
  const vocabulary = buildVocabulary();

  it('is the file in the repository (regenerate with `pnpm --filter @caseguard/domain run eval:vocabulary`)', () => {
    expect(readCommittedVocabulary()).toBe(serializeVocabulary(vocabulary));
  });

  it('lists every signal, action, requirement and hypothesis of the pack exactly once', () => {
    const ids = (items: readonly { id: string }[]) => items.map((item) => item.id).sort();
    expect(ids(vocabulary.signals)).toEqual(ids(TEAMS_AUTH_PACK.signals));
    expect(ids(vocabulary.actions)).toEqual(ids(TEAMS_AUTH_PACK.actions));
    expect(ids(vocabulary.requirements)).toEqual(ids(TEAMS_AUTH_PACK.requirements));
    expect(ids(vocabulary.hypotheses)).toEqual(ids(TEAMS_AUTH_PACK.hypotheses));
    expect(new Set(ids(vocabulary.signals)).size).toBe(vocabulary.signals.length);
  });

  it('gives every signal exactly one known dimension, and no dimension is empty', () => {
    for (const signal of vocabulary.signals) {
      expect(EVAL_DIMENSIONS).toContain(signal.dimension);
      expect(SIGNAL_DIMENSIONS[signal.id]).toBe(signal.dimension);
    }
    for (const dimension of EVAL_DIMENSIONS) {
      expect(vocabulary.signals.some((signal) => signal.dimension === dimension)).toBe(true);
    }
  });

  it('carries identifiers, labels and descriptions only, never a detector pattern', () => {
    const keys = new Set<string>();
    const strings: string[] = [];
    collect(vocabulary, keys, strings);
    expect([...keys].filter((key) => !ALLOWED_KEYS.has(key))).toEqual([]);

    const patterns: string[] = [];
    const sources = [
      ...TEAMS_AUTH_PACK.signals.flatMap((signal) => signal.detectors),
      ...TEAMS_AUTH_PACK.actions.flatMap((action) => action.detectors),
      ...TEAMS_AUTH_PACK.requirements.flatMap((requirement) => requirement.satisfiedByDetectors),
    ];
    for (const detector of sources) if (detector.kind === 'regex') patterns.push(detector.pattern);
    expect(patterns.length).toBeGreaterThan(20);
    for (const pattern of patterns) {
      expect(strings.some((text) => text.includes(pattern))).toBe(false);
    }
  });

  it('fails loudly when the pack gains a signal that has no dimension', () => {
    const extended = {
      ...TEAMS_AUTH_PACK,
      signals: [...TEAMS_AUTH_PACK.signals, { ...TEAMS_AUTH_PACK.signals[0]!, id: 'sig.new-one' }],
    };
    expect(() => buildVocabulary(extended)).toThrow(/sig\.new-one/);
  });
});
