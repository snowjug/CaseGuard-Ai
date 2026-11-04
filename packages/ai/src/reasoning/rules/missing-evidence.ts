import { isRecord } from '../text';
import type { ProposalIssue } from '../types';

const NO_CITATION = 'The proposal carries no citation: every finding must quote the record.';

const isEmptyOrMissing = (value: unknown): boolean => !Array.isArray(value) || value.length === 0;

/**
 * Every proposal has to quote the record: its own `evidence`, and for a synthesis the evidence of each key point.
 * (A critique without a citation is `critic_new_story`, not this.)
 */
export function checkMissingEvidence(raw: unknown): ProposalIssue[] {
  if (!isRecord(raw)) return [];
  const issues: ProposalIssue[] = [];
  if (isEmptyOrMissing(raw.evidence)) {
    issues.push({ code: 'missing_evidence', path: 'evidence', message: NO_CITATION });
  }
  if (raw.type === 'case_synthesis' && Array.isArray(raw.keyPoints)) {
    raw.keyPoints.forEach((point, i) => {
      if (isRecord(point) && isEmptyOrMissing(point.evidence) && issues.length < 6) {
        issues.push({
          code: 'missing_evidence',
          path: `keyPoints[${i}].evidence`,
          message: NO_CITATION,
        });
      }
    });
  }
  return issues;
}
