import { canonicalJson, sha256Hex } from '../../src/hashing';
import { CORPUS_CUSTOM_PATTERNS, makeCustomText, makeRecord, makeText } from './corpus';
import { SECRET_REDACTION_CATEGORIES } from '../../src/redaction/redact-text';
import type { RedactionOptions } from '../../src/redaction/types';

/*
 * Descriptions of the golden regression cases. The expected hashes (`fixtures/redaction-golden.json`)
 * were produced by the redaction engine as it was before the Unicode-folding and batching work, so
 * the cases prove that plain ASCII input still redacts to byte-identical output with identical
 * counts, finding order and pseudonym numbering.
 */

export const SINGLE_CASES = 900;
export const GROUP_CASES = 150;
export const VALUE_CASES = 120;
export const CUSTOM_GROUP_CASES = 80;
export const GROUP_SIZE = 4;

const VARIANTS: readonly RedactionOptions[] = [
  {},
  { enabledCategories: SECRET_REDACTION_CATEGORIES },
  { redactReservedValues: true },
];

export const digest = (text: string, length = 12): string => sha256Hex(text).slice(0, length);

export interface FindingLike {
  readonly category: string;
  readonly count: number;
  readonly placeholder: string;
}

/** `[hash of the redacted output, replacement count, hash of the findings]`. */
export type Triple = [output: string, count: number, findings: string];

export function triple(output: string, count: number, findings: readonly FindingLike[]): Triple {
  return [digest(output), count, digest(canonicalJson(findings), 8)];
}

export function singleCase(index: number): { text: string; options: RedactionOptions } {
  return {
    text: makeText(10_000 + index),
    options: VARIANTS[index % VARIANTS.length] as RedactionOptions,
  };
}

export function groupCase(index: number): { texts: string[]; options: RedactionOptions } {
  return {
    texts: Array.from({ length: GROUP_SIZE }, (_, k) => makeText(50_000 + index * GROUP_SIZE + k)),
    options: index % 2 === 0 ? {} : { redactReservedValues: true },
  };
}

export function valueCase(index: number): {
  value: Record<string, unknown>;
  options: RedactionOptions;
} {
  return {
    value: makeRecord(70_000 + index),
    options: index % 2 === 0 ? {} : { enabledCategories: SECRET_REDACTION_CATEGORIES },
  };
}

export function customGroupCase(index: number): { texts: string[]; options: RedactionOptions } {
  return {
    texts: Array.from({ length: GROUP_SIZE }, (_, k) =>
      makeCustomText(90_000 + index * GROUP_SIZE + k),
    ),
    options: { customPatterns: CORPUS_CUSTOM_PATTERNS },
  };
}

export interface GoldenFile {
  readonly single: Triple[];
  readonly groups: Triple[][];
  readonly values: Triple[];
  readonly custom: Triple[][];
}
