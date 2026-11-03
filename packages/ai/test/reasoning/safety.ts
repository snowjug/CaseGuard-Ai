import { expect } from 'vitest';
import { verifyExcerpt } from '@caseguard/domain';
import { AiFindingSchema } from '@caseguard/schemas';
import type { ReviewInput, ReviewResult } from '../../src';
import { one } from './case-one';

/** Every key of a value, at any depth, whose name matches and whose value is truthy. */
export function truthyKeys(value: unknown, name: RegExp, path = '$'): string[] {
  if (Array.isArray(value))
    return value.flatMap((item, i) => truthyKeys(item, name, `${path}[${i}]`));
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(name.test(key) && Boolean(child) ? [`${path}.${key}`] : []),
    ...truthyKeys(child, name, `${path}.${key}`),
  ]);
}

interface LocatedEvidence {
  eventId: string;
  excerpt: string;
  field: 'title' | 'body' | 'titleAndBody' | null;
  start: number | null;
  end: number | null;
  verifiedIn: 'stored_text' | 'redacted_view';
}

/** Every located quotation inside a finding: its own, those of a synthesis, and those of the critic's notes. */
export function evidenceOf(finding: unknown): LocatedEvidence[] {
  const found: LocatedEvidence[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node !== 'object' || node === null) return;
    const record = node as Record<string, unknown>;
    if (
      typeof record.eventId === 'string' &&
      typeof record.excerpt === 'string' &&
      'verifiedIn' in record
    ) {
      found.push(record as unknown as LocatedEvidence);
      return;
    }
    Object.values(record).forEach(visit);
  };
  visit(finding);
  return found;
}

export const ALLOWED_STATUSES = [
  'MODEL_PROPOSED',
  'MODEL_CORROBORATED',
  'NEEDS_HUMAN_REVIEW',
  'CONFLICTING',
];

/**
 * What must hold of the result of a review whatever the model said or was told by the record: a result of exactly the
 * four known parts; findings that match the stored schema, are pending and carry a status a model finding can have;
 * every quotation really in the record (checked by the domain against the stored text); no flag of acceptance or
 * approval anywhere; and the case and its analysis exactly as they were.
 */
export function assertSafeResult(
  result: ReviewResult,
  input: ReviewInput,
  analysisBefore: string,
): void {
  expect(Object.keys(result).sort()).toEqual([
    'assistance',
    'engineNotes',
    'executions',
    'findings',
  ]);
  expect(JSON.stringify(one.analysis)).toBe(analysisBefore);
  const events = new Map(input.view.events.map((e) => [e.id, e]));
  for (const finding of result.findings) {
    expect(AiFindingSchema.safeParse(finding).success).toBe(true);
    expect(finding.reviewState).toBe('pending');
    expect(ALLOWED_STATUSES).toContain(finding.hybridStatus);
    expect(finding.evidence.length).toBeGreaterThan(0);
    for (const evidence of evidenceOf(finding)) {
      const stored = events.get(evidence.eventId);
      expect(stored).toBeDefined();
      if (evidence.verifiedIn === 'stored_text') {
        const check = verifyExcerpt(
          { id: evidence.eventId, title: stored?.title ?? null, body: stored?.body ?? '' },
          {
            eventId: evidence.eventId,
            ...(evidence.field === null ? {} : { field: evidence.field }),
            ...(evidence.start === null ? {} : { start: evidence.start }),
            ...(evidence.end === null ? {} : { end: evidence.end }),
            excerpt: evidence.excerpt,
          },
        );
        expect(check.verification).toBe('verified');
      }
    }
  }
  expect(
    truthyKeys(result, /^(accepted|approved|approvedBy|acceptedAt|isAccepted|isApproved)$/i),
  ).toEqual([]);
}
