import type { TextAt } from './types';

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Unicode NFC and whitespace runs collapsed to one space, on both sides of every comparison and nothing else. */
export const normaliseExcerpt = (text: string): string =>
  text.normalize('NFC').replace(/\s+/g, ' ').trim();

/** A path with every character but the ones a key we wrote can have removed, so a model-chosen key never reaches a log. */
export function sanitisePath(path: string): string {
  const clean = path.replace(/[^A-Za-z0-9_.[\]-]/g, '').slice(0, 120);
  return clean === '' ? '$' : clean;
}

/** Keys whose string values are references or enumerated values, not free text. */
const NOT_TEXT_KEYS: ReadonlySet<string> = new Set([
  'id',
  'type',
  'eventId',
  'decisionEventId',
  'neededByEventId',
  'availableEventIds',
  'signalId',
  'requirementId',
  'actionId',
  'skillId',
  'targetId',
  'alternativeHypothesisId',
  'confidence',
  'confidenceBasis',
  'kind',
  'verdict',
  'feasible',
  'priority',
  'ownerRole',
  'basis',
  'conflictClass',
  'level',
]);

/**
 * The free text of a proposal: what the model wrote (`own`) and what it quoted from the record (`quoted`, the
 * `excerpt` of every citation). References and enumerated values are not text.
 */
export function collectProposalTexts(node: unknown): { own: TextAt[]; quoted: TextAt[] } {
  const own: TextAt[] = [];
  const quoted: TextAt[] = [];
  const visit = (value: unknown, path: string, key: string | null): void => {
    if (typeof value === 'string') {
      if (key === 'excerpt') quoted.push({ path, text: value });
      else if (key === null || !NOT_TEXT_KEYS.has(key)) own.push({ path, text: value });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => visit(item, `${path}[${i}]`, key));
      return;
    }
    if (!isRecord(value)) return;
    for (const [k, child] of Object.entries(value)) {
      visit(child, path === '' ? k : `${path}.${k}`, k);
    }
  };
  visit(node, '', null);
  return { own, quoted };
}

export type EventRefRole = 'evidence' | 'anchor' | 'available' | 'side' | 'contradiction';

export interface EventRef {
  path: string;
  eventId: string;
  role: EventRefRole;
}

/** Every event the proposal names, with where and in what role. */
export function collectEventRefs(node: unknown): EventRef[] {
  const refs: EventRef[] = [];
  const roleOf = (path: string): EventRefRole =>
    path.includes('evidence[')
      ? 'evidence'
      : path.includes('contradictions[')
        ? 'contradiction'
        : path.includes('sides[')
          ? 'side'
          : 'anchor';
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => visit(item, `${path}[${i}]`));
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = path === '' ? key : `${path}.${key}`;
      if (
        (key === 'eventId' || key === 'decisionEventId' || key === 'neededByEventId') &&
        typeof child === 'string'
      ) {
        refs.push({ path: childPath, eventId: child, role: roleOf(childPath) });
      } else if (key === 'availableEventIds' && Array.isArray(child)) {
        child.forEach((id, i) => {
          if (typeof id === 'string') {
            refs.push({ path: `${childPath}[${i}]`, eventId: id, role: 'available' });
          }
        });
      } else {
        visit(child, childPath);
      }
    }
  };
  visit(node, '');
  return refs;
}

/** All citations of a proposal (`{ eventId, excerpt }` pairs), with their paths. */
export function collectCitations(
  node: unknown,
): { path: string; eventId: string; excerpt: string }[] {
  const found: { path: string; eventId: string; excerpt: string }[] = [];
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => visit(item, `${path}[${i}]`));
      return;
    }
    if (!isRecord(value)) return;
    if (typeof value.eventId === 'string' && typeof value.excerpt === 'string') {
      found.push({ path, eventId: value.eventId, excerpt: value.excerpt });
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      visit(child, path === '' ? key : `${path}.${key}`);
    }
  };
  visit(node, '');
  return found;
}
