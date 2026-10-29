import { createHash } from 'node:crypto';

/**
 * Deterministic id derived from stable parts. Analysis artefact ids must be reproducible so that
 * re-running an analysis replaces previous artefacts and carries forward reviewer decisions.
 */
export function stableId(prefix: string, ...parts: readonly (string | number)[]): string {
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
  return `${prefix}_${digest}`;
}

/** Hash of arbitrary JSON-compatible data with stable key ordering. */
export function hashJson(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/** Record id of the Hypothesis artefact for a knowledge-pack hypothesis key within one case. */
export const hypothesisRecordId = (caseId: string, key: string): string =>
  stableId('hyp', caseId, key);

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}
