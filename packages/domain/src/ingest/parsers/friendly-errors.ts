import type { ZodError } from 'zod';
import { displayValue } from './text';
import type { ParseIssue, ParseIssueCode } from './types';

type ZodIssueLike = ZodError['issues'][number];
type PathKey = PropertyKey;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** `events[3].timestamp` instead of Zod's raw path array. Keys come from the document, so they are bounded. */
export function formatPath(path: readonly PathKey[]): string {
  if (path.length === 0) return '(root)';
  let out = '';
  for (const key of path) {
    if (out.length > 300) break;
    if (typeof key === 'number') out += `[${key}]`;
    else if (typeof key === 'symbol') out += '[symbol]';
    else if (key.length <= 40 && IDENTIFIER.test(key)) out += out.length === 0 ? key : `.${key}`;
    else out += `[${JSON.stringify(displayValue(key, 40))}]`;
  }
  return out.length > 300 ? `${out.slice(0, 299)}…` : out;
}

function valueAt(root: unknown, path: readonly PathKey[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) {
      current = typeof key === 'number' ? current[key] : undefined;
    } else if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(current, key)) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Short, safe description of what was actually supplied. */
export function describeReceived(value: unknown): string {
  if (value === undefined) return '(missing)';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(displayValue(value, 60));
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value))
    return `array with ${value.length} item${value.length === 1 ? '' : 's'}`;
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    const shown = keys.slice(0, 5).map((k) => displayValue(k, 20));
    return `object with ${keys.length} key${keys.length === 1 ? '' : 's'}${
      shown.length > 0 ? ` (${shown.join(', ')}${keys.length > 5 ? ', …' : ''})` : ''
    }`;
  }
  return typeof value;
}

function typeName(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}

const article = (word: string): string => (/^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`);

export function levenshtein(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = row;
  }
  return previous[b.length] ?? 3;
}

/** Spots a typo such as `timestmap` next to a missing `timestamp`. */
function suggestKey(root: unknown, path: readonly PathKey[], missing: string): string | null {
  if (missing.length < 4) return null;
  const parent = valueAt(root, path.slice(0, -1));
  if (parent === null || typeof parent !== 'object' || Array.isArray(parent)) return null;
  const wanted = missing.toLowerCase();
  for (const key of Object.keys(parent)) {
    if (key === missing) continue;
    if (key.toLowerCase() === wanted || levenshtein(key.toLowerCase(), wanted) <= 2) return key;
  }
  return null;
}

const CODE_FOR = new Map<string, ParseIssueCode>([
  ['invalid_type', 'schema_invalid_type'],
  ['invalid_value', 'schema_invalid_value'],
  ['too_small', 'schema_too_small'],
  ['too_big', 'schema_too_big'],
  ['invalid_format', 'schema_invalid_format'],
  ['custom', 'schema_custom'],
]);

const TIMESTAMP_HINT =
  'Use a UTC ISO-8601 timestamp with a trailing Z, for example 2026-03-09T09:12:00Z.';
const FIELD_HINTS = new Map<string, string>([
  ['timestamp', TIMESTAMP_HINT],
  ['openedAt', TIMESTAMP_HINT],
  ['closedAt', TIMESTAMP_HINT],
  ['resolvedAt', TIMESTAMP_HINT],
  ['validatedAt', TIMESTAMP_HINT],
  [
    'id',
    'Identifiers may contain letters, digits, underscore, dot, colon and dash, and must start with a letter or digit.',
  ],
  [
    'participantId',
    'Use the id of one of the entries in "participants" (letters, digits, _ . : - only).',
  ],
  [
    'reference',
    'Use upper-case letters, digits and dashes, 4-40 characters, for example CG-SYN-1001.',
  ],
]);

function customHint(message: string): string {
  if (/^Duplicate participant id/.test(message)) {
    return 'Give every participant a unique "id" and reference each one by that id.';
  }
  if (/^Duplicate event id/.test(message)) return 'Give every event a unique "id".';
  if (/^Unknown participant/.test(message)) {
    return 'Add that participant to "participants", or correct "participantId" on the event.';
  }
  if (/inResponseTo references unknown event/.test(message)) {
    return 'Point "inResponseTo" at the "id" of an event in this bundle, or remove it.';
  }
  if (/repeatOf references unknown event/.test(message)) {
    return 'Point "repeatOf" at the "id" of an earlier action event, or remove it.';
  }
  if (/earlier than case\.openedAt/.test(message)) {
    return 'Set case.openedAt to the time of the first event or earlier.';
  }
  if (/Validation evidence references unknown event/.test(message)) {
    return 'List only ids of events that exist in this bundle in "evidenceEventIds".';
  }
  return 'Compare the value with the case bundle JSON Schema (GET /api/v1/schemas/case-bundle.schema.json).';
}

function limitText(issue: ZodIssueLike, bound: 'minimum' | 'maximum'): string {
  const record = issue as unknown as Record<string, unknown>;
  const value = record[bound];
  const origin = typeof record.origin === 'string' ? record.origin : 'value';
  const amount = typeof value === 'number' || typeof value === 'bigint' ? String(value) : '?';
  if (origin === 'string') return `${amount} character${amount === '1' ? '' : 's'}`;
  if (origin === 'array' || origin === 'set') return `${amount} item${amount === '1' ? '' : 's'}`;
  return amount;
}

function leafOf(path: readonly PathKey[]): string {
  const last = path[path.length - 1];
  if (typeof last === 'number') {
    const parent = path[path.length - 2];
    return parent === undefined ? `[${last}]` : `${String(parent)}[${last}]`;
  }
  return last === undefined ? 'value' : String(last);
}

function convert(issue: ZodIssueLike, root: unknown): ParseIssue {
  const path = formatPath(issue.path);
  const value = valueAt(root, issue.path);
  const received = describeReceived(value);
  const rawLeaf = leafOf(issue.path);
  // The leaf can be a key taken from the document, so it is shortened before it enters a message.
  const leaf = displayValue(rawLeaf, 40);
  const record = issue as unknown as Record<string, unknown>;
  const code = CODE_FOR.get(issue.code) ?? 'schema_invalid';
  const fieldHint = FIELD_HINTS.get(rawLeaf);
  const base = { code, path, received } as const;

  if (value === undefined && (issue.code === 'invalid_value' || issue.code === 'invalid_format')) {
    const values = Array.isArray(record.values) ? record.values.map((v) => String(v)) : [];
    return {
      ...base,
      code: 'schema_invalid_type',
      message: `"${leaf}" is required but is missing.`,
      hint:
        fieldHint ??
        (values.length > 0
          ? `Add "${leaf}" with one of: ${values.slice(0, 12).join(', ')}.`
          : `Add "${leaf}".`),
    };
  }

  switch (issue.code) {
    case 'invalid_type': {
      const expected = typeof record.expected === 'string' ? record.expected : 'value';
      if (value === undefined) {
        const typo = suggestKey(root, issue.path, leaf);
        return {
          ...base,
          message: `"${leaf}" is required but is missing.`,
          hint:
            typo !== null
              ? `Found "${typo}" instead - did you mean "${leaf}"?`
              : (fieldHint ?? `Add "${leaf}" (${article(expected)}).`),
        };
      }
      return {
        ...base,
        message: `"${leaf}" must be ${article(expected)} but ${typeName(value)} was given.`,
        hint: fieldHint ?? `Change "${leaf}" to ${article(expected)}.`,
      };
    }
    case 'invalid_value': {
      const values = Array.isArray(record.values) ? record.values.map((v) => String(v)) : [];
      const shown = values.slice(0, 12).join(', ') + (values.length > 12 ? ', …' : '');
      return {
        ...base,
        message: `"${leaf}" has a value that is not allowed.`,
        hint:
          values.length > 0 ? `Use one of: ${shown}.` : 'Use one of the values in the JSON Schema.',
      };
    }
    case 'too_small':
      return {
        ...base,
        message: `"${leaf}" is too short or too small: it needs at least ${limitText(issue, 'minimum')}.`,
        hint: `Provide at least ${limitText(issue, 'minimum')} for "${leaf}".`,
      };
    case 'too_big':
      return {
        ...base,
        message: `"${leaf}" is too long or too large: at most ${limitText(issue, 'maximum')} are allowed.`,
        hint: `Shorten "${leaf}" to at most ${limitText(issue, 'maximum')}, or split the content.`,
      };
    case 'invalid_format': {
      const format = typeof record.format === 'string' ? record.format : '';
      if (format === 'datetime') {
        return {
          ...base,
          message: `"${leaf}" is not a UTC ISO-8601 timestamp.`,
          hint: 'Use the form 2026-03-09T09:12:00Z (UTC, trailing Z; offsets such as +02:00 are not accepted).',
        };
      }
      return {
        ...base,
        message: `"${leaf}" does not match the required format.`,
        hint: fieldHint ?? issue.message,
      };
    }
    case 'custom':
      return { ...base, message: issue.message, hint: customHint(issue.message) };
    case 'invalid_union':
      return {
        ...base,
        message: `"${leaf}" has an unsupported type.`,
        hint: path.includes('.structured')
          ? 'Structured values must be a string (up to 500 chars), number, boolean, null, or an array of up to 50 strings, numbers or booleans.'
          : 'Compare the value with the case bundle JSON Schema.',
      };
    default:
      return {
        ...base,
        message: issue.message,
        hint: 'Compare the value with the case bundle JSON Schema.',
      };
  }
}

/** Turns Zod issues into field-level errors written for the person fixing the file. */
export function friendlyIssues(
  issues: readonly ZodIssueLike[],
  root: unknown,
  maxErrors: number,
): ParseIssue[] {
  const out: ParseIssue[] = [];
  for (const issue of issues) {
    if (out.length >= maxErrors) {
      out.push({
        code: 'errors_truncated',
        path: '(root)',
        message: `${issues.length - maxErrors} more problem(s) are not listed.`,
        hint: 'Fix the problems above and validate again to see the rest.',
        received: null,
      });
      break;
    }
    out.push(convert(issue, root));
  }
  return out;
}
