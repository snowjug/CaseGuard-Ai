import type { Range } from '@caseguard/schemas';

/** Truncates to a schema limit with an ellipsis so generated text never fails validation. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** `act.signin-log-correlation` becomes `signin-log-correlation`. */
export const actionSlug = (actionKey: string): string => actionKey.replace(/^act\./, '');

export const pct = (p: number): string => `${Math.round(p * 100)}%`;

export function uniq<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

/** Placeholder names (`{{name}}`) in a template, in order of first appearance. */
export function placeholdersIn(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) {
    const name = match[1];
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}

export function parseSemver(version: string): [number, number, number] {
  const [major = '0', minor = '0', patch = '0'] = version.split('.');
  return [Number(major), Number(minor), Number(patch)];
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Next version above the highest existing one: mutations bump the minor, rollbacks and edits the patch. */
export function bumpSemver(highest: string, kind: 'minor' | 'patch'): string {
  const [major, minor, patch] = parseSemver(highest);
  return kind === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

export const sumRange = (ranges: readonly Range[]): Range => ({
  low: ranges.reduce((s, r) => s + r.low, 0),
  mid: ranges.reduce((s, r) => s + r.mid, 0),
  high: ranges.reduce((s, r) => s + r.high, 0),
});

export const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
