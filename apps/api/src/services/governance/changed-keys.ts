import { canonicalJson } from '../../db/hash';

/** Longest list recorded in one audit event (the audit scrubber bounds arrays at 100). */
const MAX_CHANGED_KEYS = 100;
const MAX_KEY_LENGTH = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameValue(before: unknown, after: unknown): boolean {
  if (before === undefined || after === undefined) return before === after;
  return canonicalJson(before) === canonicalJson(after);
}

/**
 * Dotted paths of the settings that differ between two values (`agentBudgets.quality_judge.maxRetries`).
 * Objects are compared key by key; arrays and scalars as a whole. Only paths are returned, never
 * values, so the result is safe to put in an audit event.
 */
export function changedKeys(before: unknown, after: unknown): string[] {
  const keys: string[] = [];
  const visit = (previous: unknown, next: unknown, path: string): void => {
    if (isRecord(previous) && isRecord(next)) {
      for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
        visit(previous[key], next[key], path === '' ? key : `${path}.${key}`);
      }
      return;
    }
    if (!sameValue(previous, next))
      keys.push(path === '' ? '(value)' : path.slice(0, MAX_KEY_LENGTH));
  };
  visit(before, after, '');
  return keys.sort().slice(0, MAX_CHANGED_KEYS);
}
