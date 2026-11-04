import { PROPOSAL_SCHEMAS, type AnyProposal, type FindingType } from '@caseguard/schemas';
import type { z } from 'zod';

export type ZodIssue = z.ZodError['issues'][number];

export interface ParsedProposal {
  parsed: AnyProposal | null;
  /** The schema violations, as the schema reported them. The rules below sort them into codes. */
  issues: readonly ZodIssue[];
}

/** Parses one element of a reply against the strict schema of its type. */
export function parseProposal(type: FindingType, raw: unknown): ParsedProposal {
  const result = PROPOSAL_SCHEMAS[type].safeParse(raw);
  return result.success
    ? { parsed: result.data, issues: [] }
    : { parsed: null, issues: result.error.issues };
}

/** A path made of the keys of our own schema; a key the model chose is never part of it. */
export function pathOf(path: readonly PropertyKey[]): string {
  const text = path.reduce<string>((acc, part) => {
    if (typeof part === 'number') return `${acc}[${part}]`;
    const key = typeof part === 'symbol' ? 'symbol' : part;
    return acc === '' ? key : `${acc}.${key}`;
  }, '');
  return text === '' ? '$' : text;
}
