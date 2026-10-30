import type { EffortLevel, ExtractionMethod, ReviewState, SourceKind } from '@caseguard/schemas';
import type { BadgeStatus } from '@caseguard/ui';

/** Display labels shared by the case pages (overview, timeline, ledger, ingestion). */

export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  builtin_sample: 'Built-in sample',
  pasted_text: 'Pasted text',
  uploaded_file: 'Uploaded file',
  json_bundle: 'JSON bundle',
};

/** How a value was extracted. Only `llm` is model output; every other method is deterministic code. */
export const METHOD_LABELS: Record<ExtractionMethod, string> = {
  structured: 'Structured field',
  rule: 'Rule',
  pattern: 'Pattern match',
  derived: 'Derived',
  llm: 'Language model',
  human: 'Human',
};

export const REVIEW_STATE_LABELS: Record<ReviewState, { label: string; status: BadgeStatus }> = {
  pending: { label: 'Awaiting review', status: 'neutral' },
  confirmed: { label: 'Confirmed by a reviewer', status: 'productive' },
  corrected: { label: 'Corrected by a reviewer', status: 'uncertain' },
  rejected: { label: 'Rejected by a reviewer', status: 'unsupported' },
};

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  none: 'No customer effort',
  low: 'Low customer effort',
  medium: 'Medium customer effort',
  high: 'High customer effort',
  very_high: 'Very high customer effort',
};

/** Plural-aware count: `1 event`, `2 events`. */
export function countOf(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
