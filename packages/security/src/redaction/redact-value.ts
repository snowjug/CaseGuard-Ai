import type { RedactionCategory } from '@caseguard/schemas';
import { DEFAULT_REDACTION_OPTIONS } from './defaults';
import { redactBatchInto, type EngineConfig } from './engine';
import { foldForDetection } from './fold';
import { createPseudonymState, type PseudonymState } from './pseudonyms';
import { placeholderFor } from './rules';
import {
  countHit,
  createTally,
  findingsFrom,
  mergeCounts,
  totalOf,
  type RedactionTally,
} from './tally';
import type { RedactionBatchResult, RedactionOptions, RedactionValueResult } from './types';

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
  const normalized = (foldForDetection(key)?.text ?? key).toLowerCase().replace(/[^a-z0-9]/g, '');
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

/**
 * Gathers every string leaf of the inputs so they can be redacted in one batch. The output structure
 * is built immediately (so key order is preserved); string leaves are filled in once the batch is done.
 */
interface Collector {
  readonly enabled: ReadonlySet<RedactionCategory>;
  readonly leaves: string[];
  readonly owners: number[];
  readonly setters: ((text: string) => void)[];
  readonly tallies: RedactionTally[];
  readonly ancestors: WeakSet<object>;
}

function collect(
  collector: Collector,
  value: unknown,
  key: string | null,
  depth: number,
  owner: number,
  assign: (result: unknown) => void,
): void {
  if (typeof value === 'string') {
    if (key !== null && value.length > 0 && !value.startsWith('[REDACTED:')) {
      const category = categoryForKey(key);
      if (category !== null && collector.enabled.has(category)) {
        const tally = collector.tallies[owner];
        if (tally !== undefined) countHit(tally, category);
        assign(placeholderFor(category));
        return;
      }
    }
    collector.leaves.push(value);
    collector.owners.push(owner);
    collector.setters.push(assign);
    return;
  }
  if (value === null || typeof value !== 'object') {
    assign(value);
    return;
  }

  if (depth > MAX_DEPTH) throw new RangeError(`redactValue: nesting deeper than ${MAX_DEPTH}`);
  if (collector.ancestors.has(value)) throw new TypeError('redactValue: circular structure');

  const isArray = Array.isArray(value);
  if (!isArray && !isPlainObject(value)) {
    assign(value); // Dates and class instances are not JSON data.
    return;
  }

  collector.ancestors.add(value);
  try {
    if (isArray) {
      const items = value as unknown[];
      const out = new Array<unknown>(items.length);
      assign(out);
      items.forEach((item, index) => {
        collect(collector, item, key, depth + 1, owner, (result) => {
          out[index] = result;
        });
      });
      return;
    }
    const out: Record<string, unknown> = {};
    assign(out);
    for (const [property, member] of Object.entries(value)) {
      // defineProperty keeps a JSON-parsed "__proto__" key as plain data instead of re-parenting `out`.
      const define = (result: unknown): void => {
        Object.defineProperty(out, property, {
          value: result,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      };
      define(undefined); // Reserves the key's position; a string leaf is filled in after the batch.
      collect(collector, member, property, depth + 1, owner, define);
    }
  } finally {
    collector.ancestors.delete(value);
  }
}

/**
 * Deep redaction of many JSON-like values in one batch: every string leaf is redacted with the rules of
 * `redactTexts` (custom patterns run once per pattern over all leaves of all values), and string values
 * under secret-named properties (`password`, `apiKey`, `connectionString`, ...) are replaced outright.
 * Inputs are never mutated; non-JSON objects (dates, class instances) pass through. Strings are
 * processed in depth-first order, so pseudonym numbering equals that of redacting them one by one.
 *
 * Check `complete` as for `redactTexts`.
 */
export function redactValues<T>(
  values: readonly T[],
  options: RedactionOptions = {},
  state: PseudonymState = createPseudonymState(),
): RedactionBatchResult<T> {
  return redactValuesWith(values, options, state, {});
}

/** `redactValues` with the engine's internals exposed (rules, pass limit, sandbox runner): for tests. */
export function redactValuesWith<T>(
  values: readonly T[],
  options: RedactionOptions,
  state: PseudonymState,
  engine: Partial<EngineConfig>,
): RedactionBatchResult<T> {
  const tallies = values.map(() => createTally());
  const out = new Array<unknown>(values.length);
  const collector: Collector = {
    enabled: new Set<RedactionCategory>(
      options.enabledCategories ?? DEFAULT_REDACTION_OPTIONS.enabledCategories,
    ),
    leaves: [],
    owners: [],
    setters: [],
    tallies,
    ancestors: new WeakSet(),
  };
  values.forEach((value, index) => {
    collect(collector, value, null, 0, index, (result) => {
      out[index] = result;
    });
  });

  const leafTallies = collector.owners.map((owner) => tallies[owner] ?? createTally());
  const outcome = redactBatchInto(collector.leaves, options, state, leafTallies, engine);
  outcome.texts.forEach((text, leaf) => collector.setters[leaf]?.(text));

  const all = createTally();
  for (const tally of tallies) mergeCounts(all, tally);
  return {
    items: values.map((_, index) => {
      const tally = tallies[index] ?? createTally();
      return {
        value: out[index] as T,
        findings: findingsFrom(tally),
        totalReplacements: totalOf(tally),
      };
    }),
    findings: findingsFrom(all),
    totalReplacements: totalOf(all),
    notes: outcome.notes,
    complete: outcome.failures.length === 0,
    failures: outcome.failures,
  };
}

/**
 * Deep redaction of one JSON-like value (see `redactValues`).
 *
 * @deprecated Calling this per field evaluates every custom pattern once per string. Collect the
 * values and call `redactValues` once per request. The result also carries `complete`/`failures`:
 * ignoring them means a custom pattern that could not run is skipped.
 */
export function redactValue<T>(
  value: T,
  options: RedactionOptions = {},
  state: PseudonymState = createPseudonymState(),
): RedactionValueResult<T> {
  const batch = redactValues([value], options, state);
  const item = batch.items[0];
  return {
    value: item === undefined ? value : item.value,
    findings: batch.findings,
    totalReplacements: batch.totalReplacements,
    notes: batch.notes,
    complete: batch.complete,
    failures: batch.failures,
  };
}
