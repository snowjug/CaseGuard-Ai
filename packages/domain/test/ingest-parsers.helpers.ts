import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect } from 'vitest';
import { CaseBundleSchema, type CaseBundle } from '@caseguard/schemas';
import type {
  IngestFailure,
  IngestIssue,
  IngestParseResult,
  IngestSuccess,
} from '../src/ingest/parsers';

export const NOW = '2026-10-29T00:00:00Z';
/** Options every parser call needs: the synthetic flag is explicit and the clock is injected. */
export const BASE = { synthetic: true, now: NOW } as const;

const examplesDir = resolve(import.meta.dirname, '../../../synthetic-data/examples');
export const readExample = (name: string): string =>
  readFileSync(resolve(examplesDir, name), 'utf8');

export function expectOk(result: IngestParseResult): IngestSuccess {
  if (!result.ok) {
    throw new Error(`Expected a draft but got errors:\n${JSON.stringify(result.errors, null, 2)}`);
  }
  return result;
}

export function expectFailure(result: IngestParseResult): IngestFailure {
  if (result.ok) throw new Error('Expected a failure but the parse succeeded.');
  return result;
}

/** Invariants every draft must satisfy, whatever the input was. */
export function expectValidDraft(bundle: CaseBundle): void {
  expect(CaseBundleSchema.safeParse(bundle).success).toBe(true);
  const stamps = bundle.events.map((e) => Date.parse(e.timestamp));
  expect(stamps.every((ms) => Number.isFinite(ms))).toBe(true);
  expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
  const ids = new Set(bundle.events.map((e) => e.id));
  expect(ids.size).toBe(bundle.events.length);
  const participants = new Set(bundle.participants.map((p) => p.id));
  for (const event of bundle.events) {
    expect(participants.has(event.participantId)).toBe(true);
    if (event.inResponseTo) expect(ids.has(event.inResponseTo)).toBe(true);
  }
  expect(Date.parse(bundle.case.openedAt)).toBeLessThanOrEqual(stamps[0] ?? Infinity);
}

export const codes = (result: IngestParseResult): string[] => result.warnings.map((w) => w.code);

export function firstError(result: IngestParseResult): IngestIssue {
  const error = expectFailure(result).errors[0];
  if (!error) throw new Error('The failure carries no errors.');
  return error;
}

/** `[path, value]`; an `undefined` value deletes the key. Paths are dotted, array indexes are numbers. */
export type Change = readonly [path: string, value: unknown];

/** Applies changes to a deep copy of the minimal example, so each test states only what is wrong. */
export function broken(...changes: Change[]): string {
  const copy = JSON.parse(readExample('minimal-case-bundle.json')) as Record<string, unknown>;
  for (const [path, value] of changes) {
    const keys = path.split('.');
    const last = keys[keys.length - 1] ?? '';
    let target: unknown = copy;
    for (const key of keys.slice(0, -1)) target = (target as Record<string, unknown>)[key];
    if (value === undefined) delete (target as Record<string, unknown>)[last];
    else (target as Record<string, unknown>)[last] = value;
  }
  return JSON.stringify(copy);
}
