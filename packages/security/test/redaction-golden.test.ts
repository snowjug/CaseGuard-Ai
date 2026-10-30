import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/hashing';
import { createPseudonymState } from '../src/redaction/pseudonyms';
import { redactText, redactTexts } from '../src/redaction/redact-text';
import { redactValue, redactValues } from '../src/redaction/redact-value';
import {
  CUSTOM_GROUP_CASES,
  GROUP_CASES,
  SINGLE_CASES,
  VALUE_CASES,
  customGroupCase,
  groupCase,
  singleCase,
  triple,
  valueCase,
  type GoldenFile,
} from './helpers/golden';

const golden = JSON.parse(
  readFileSync(new URL('./fixtures/redaction-golden.json', import.meta.url), 'utf8'),
) as GoldenFile;

/*
 * The fixture holds hashes of what the engine produced for generated plain-ASCII inputs before the
 * Unicode-folding and batching work. Any drift in output, replacement counts, finding order or
 * pseudonym numbering fails here, which is what "ASCII behaves exactly as before" means in practice.
 */
describe(
  'redaction golden corpus (plain ASCII behaves exactly as before)',
  { timeout: 120_000 },
  () => {
    it('has the expected shape', () => {
      expect(golden.single).toHaveLength(SINGLE_CASES);
      expect(golden.groups).toHaveLength(GROUP_CASES);
      expect(golden.values).toHaveLength(VALUE_CASES);
      expect(golden.custom).toHaveLength(CUSTOM_GROUP_CASES);
    });

    it('single texts: output, counts and findings are unchanged', () => {
      const drift: number[] = [];
      for (let i = 0; i < SINGLE_CASES; i += 1) {
        const { text, options } = singleCase(i);
        const result = redactText(text, options, createPseudonymState());
        const actual = triple(result.text, result.totalReplacements, result.findings);
        if (canonicalJson(actual) !== canonicalJson(golden.single[i])) drift.push(i);
      }
      expect(drift).toEqual([]);
    });

    it('sequences sharing one pseudonym state: numbering and per-text output are unchanged', () => {
      const drift: number[] = [];
      for (let g = 0; g < GROUP_CASES; g += 1) {
        const { texts, options } = groupCase(g);
        const state = createPseudonymState();
        const actual = texts.map((text) => {
          const result = redactText(text, options, state);
          return triple(result.text, result.totalReplacements, result.findings);
        });
        if (canonicalJson(actual) !== canonicalJson(golden.groups[g])) drift.push(g);
      }
      expect(drift).toEqual([]);
    });

    it('JSON-like records: secret-named keys, nested strings and counts are unchanged', () => {
      const drift: number[] = [];
      for (let v = 0; v < VALUE_CASES; v += 1) {
        const { value, options } = valueCase(v);
        const result = redactValue(value, options, createPseudonymState());
        const actual = triple(
          canonicalJson(result.value),
          result.totalReplacements,
          result.findings,
        );
        if (canonicalJson(actual) !== canonicalJson(golden.values[v])) drift.push(v);
      }
      expect(drift).toEqual([]);
    });

    it(
      'custom patterns (benign inputs): output and counts are unchanged',
      { timeout: 120_000 },
      () => {
        const drift: number[] = [];
        for (let c = 0; c < 10; c += 1) {
          const { texts, options } = customGroupCase(c);
          const group = untilComplete(() => {
            const state = createPseudonymState();
            const results = texts.map((text) => redactText(text, options, state));
            return { results, complete: results.every((result) => result.complete) };
          });
          const actual = group.results.map((result) =>
            triple(result.text, result.totalReplacements, result.findings),
          );
          if (canonicalJson(actual) !== canonicalJson(golden.custom[c])) drift.push(c);
        }
        expect(drift).toEqual([]);
      },
    );
  },
);

/** A stall of the machine can time a sandbox call out; redacting is pure, so the call can be repeated. */
function untilComplete<T extends { complete: boolean }>(run: () => T): T {
  let result = run();
  for (let attempt = 1; attempt < 5 && !result.complete; attempt += 1) result = run();
  return result;
}

describe(
  'redaction golden corpus through the batch API (one evaluation per pattern, same result)',
  { timeout: 120_000 },
  () => {
    it('redactTexts: sequences sharing one pseudonym state', () => {
      const drift: number[] = [];
      for (let g = 0; g < GROUP_CASES; g += 1) {
        const { texts, options } = groupCase(g);
        const batch = redactTexts(texts, options);
        const actual = batch.items.map((item) =>
          triple(item.value, item.totalReplacements, item.findings),
        );
        if (canonicalJson(actual) !== canonicalJson(golden.groups[g])) drift.push(g);
        expect(batch.complete).toBe(true);
      }
      expect(drift).toEqual([]);
    });

    it('redactTexts: custom patterns, all groups', { timeout: 120_000 }, () => {
      const drift: number[] = [];
      for (let c = 0; c < CUSTOM_GROUP_CASES; c += 1) {
        const { texts, options } = customGroupCase(c);
        const batch = untilComplete(() => redactTexts(texts, options));
        const actual = batch.items.map((item) =>
          triple(item.value, item.totalReplacements, item.findings),
        );
        if (canonicalJson(actual) !== canonicalJson(golden.custom[c])) drift.push(c);
        expect(batch.complete).toBe(true);
      }
      expect(drift).toEqual([]);
    });

    it('redactValues: JSON-like records, one call per record', () => {
      const drift: number[] = [];
      for (let v = 0; v < VALUE_CASES; v += 1) {
        const { value, options } = valueCase(v);
        const batch = redactValues([value], options);
        const item = batch.items[0];
        const actual = triple(
          canonicalJson(item?.value),
          item?.totalReplacements ?? 0,
          item?.findings ?? [],
        );
        if (canonicalJson(actual) !== canonicalJson(golden.values[v])) drift.push(v);
      }
      expect(drift).toEqual([]);
    });
  },
);
