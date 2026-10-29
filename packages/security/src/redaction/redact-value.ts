import type { RedactionCategory } from '@caseguard/schemas';
import { createPseudonymState, type PseudonymState } from './pseudonyms';
import {
  DEFAULT_REDACTION_OPTIONS,
  createTally,
  findingsFrom,
  redactInto,
  totalOf,
  type RedactionTally,
} from './redact-text';
import { placeholderFor } from './rules';
import type { RedactionOptions, RedactionValueResult } from './types';

const MAX_DEPTH = 100;

const PASSWORD_KEY_SUFFIXES = ['password', 'passwd', 'passphrase', 'pwd', 'secret'];
const API_KEY_SUFFIXES = ['apikey', 'subscriptionkey', 'accesskey', 'secretkey'];
const TOKEN_KEYS = new Set([
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authtoken',
  'bearertoken',
  'sessiontoken',
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
]);

/**
 * Property names whose string values are secrets regardless of what the text looks like, so
 * `{ "password": "hunter2" }` is caught even though the value alone carries no `password=` context.
 * Matching ignores case and separators (`db_password`, `dbPassword`, `DB-PASSWORD`).
 */
function categoryForKey(key: string): RedactionCategory | null {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalized.length === 0) return null;
  if (normalized.endsWith('privatekey')) return 'private_key';
  if (PASSWORD_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix)))
    return 'password_assignment';
  if (API_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return 'api_key';
  if (TOKEN_KEYS.has(normalized)) return 'bearer_token';
  if (['connectionstring', 'connstring', 'connstr'].some((suffix) => normalized.endsWith(suffix))) {
    return 'connection_string';
  }
  return null;
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

interface Walker {
  readonly options: RedactionOptions;
  readonly enabled: ReadonlySet<RedactionCategory>;
  readonly state: PseudonymState;
  readonly tally: RedactionTally;
  readonly ancestors: WeakSet<object>;
}

function walk(walker: Walker, value: unknown, key: string | null, depth: number): unknown {
  if (typeof value === 'string') {
    if (key !== null && value.length > 0 && !value.startsWith('[REDACTED:')) {
      const category = categoryForKey(key);
      if (category !== null && walker.enabled.has(category)) {
        walker.tally.counts.set(category, (walker.tally.counts.get(category) ?? 0) + 1);
        return placeholderFor(category);
      }
    }
    return redactInto(value, walker.options, walker.state, walker.tally);
  }
  if (value === null || typeof value !== 'object') return value;

  if (depth > MAX_DEPTH) throw new RangeError(`redactValue: nesting deeper than ${MAX_DEPTH}`);
  if (walker.ancestors.has(value)) throw new TypeError('redactValue: circular structure');

  const isArray = Array.isArray(value);
  if (!isArray && !isPlainObject(value)) return value; // Dates and class instances are not JSON data.

  walker.ancestors.add(value);
  try {
    if (isArray) return (value as unknown[]).map((item) => walk(walker, item, key, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [property, member] of Object.entries(value)) {
      // defineProperty keeps a JSON-parsed "__proto__" key as plain data instead of re-parenting `out`.
      Object.defineProperty(out, property, {
        value: walk(walker, member, property, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  } finally {
    walker.ancestors.delete(value);
  }
}

/**
 * Deep redaction of JSON-like data: every string is redacted with `redactText`, and string values
 * under secret-named properties (`password`, `apiKey`, `connectionString`, ...) are replaced
 * outright. The input is never mutated; non-JSON objects (dates, class instances) pass through.
 */
export function redactValue<T>(
  value: T,
  options: RedactionOptions = {},
  state: PseudonymState = createPseudonymState(),
): RedactionValueResult<T> {
  const tally = createTally();
  const enabled = new Set<RedactionCategory>(
    options.enabledCategories ?? DEFAULT_REDACTION_OPTIONS.enabledCategories,
  );
  const redacted = walk(
    { options, enabled, state, tally, ancestors: new WeakSet() },
    value,
    null,
    0,
  );
  return {
    value: redacted as T,
    findings: findingsFrom(tally),
    totalReplacements: totalOf(tally),
    notes: [...tally.notes],
  };
}
