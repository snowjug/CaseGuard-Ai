import {
  CASE_BUNDLE_SCHEMA_VERSION,
  CaseBundleSchema,
  caseBundleJsonSchema,
} from '@caseguard/schemas';
import { FORBIDDEN_KEYS, parseStrictJson, type StrictJsonError } from './json-strict';
import { describeReceived, formatPath, friendlyIssues, levenshtein } from './friendly-errors';
import { resolveLimits, type ParserLimits } from './limits';
import { displayValue, exceedsBytes, utf8Bytes, WarningCollector } from './text';
import type {
  DraftFailure,
  DraftSuccess,
  JsonBundleOptions,
  ParseConfidence,
  ParseIssue,
  ParseIssueCode,
  ParseResult,
} from './types';

const BASE_HINT =
  'Provide a case bundle JSON object (see the downloadable JSON Schema and examples).';
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const VERSION_PATTERN = /^caseguard\.case-bundle\/(\d{1,6})$/;
const CURRENT_VERSION_NUMBER = Number(CASE_BUNDLE_SCHEMA_VERSION.split('/')[1]);
const JSON_CONFIDENCE: ParseConfidence = {
  score: 1,
  level: 'high',
  reasons: ['Structured JSON was validated field by field against the case bundle schema'],
  estimated: true,
};

type PathKey = string | number;

function issue(
  code: ParseIssueCode,
  path: string,
  message: string,
  hint: string,
  received: string | null = null,
): ParseIssue {
  return { code, path, message, hint, received };
}

/** Explains a schema-version problem and, for a newer or older file, how to migrate it. */
export function checkSchemaVersion(raw: unknown): ParseIssue | null {
  if (raw === CASE_BUNDLE_SCHEMA_VERSION) return null;
  const path = 'schemaVersion';
  if (raw === undefined) {
    return issue(
      'schema_version_mismatch',
      path,
      '"schemaVersion" is missing.',
      `Add "schemaVersion": "${CASE_BUNDLE_SCHEMA_VERSION}" at the top level of the file.`,
      '(missing)',
    );
  }
  if (typeof raw !== 'string') {
    return issue(
      'schema_version_mismatch',
      path,
      `"schemaVersion" must be a string but ${describeReceived(raw)} was given.`,
      `Use "${CASE_BUNDLE_SCHEMA_VERSION}".`,
      describeReceived(raw),
    );
  }
  const shown = JSON.stringify(displayValue(raw, 60));
  const match = VERSION_PATTERN.exec(raw);
  if (!match) {
    return issue(
      'schema_version_mismatch',
      path,
      `${shown} is not a schema version CaseGuard recognises.`,
      `Use "${CASE_BUNDLE_SCHEMA_VERSION}".`,
      shown,
    );
  }
  const version = Number(match[1]);
  if (version > CURRENT_VERSION_NUMBER) {
    return issue(
      'schema_version_mismatch',
      path,
      `The bundle uses schema version ${version}, which is newer than the version ${CURRENT_VERSION_NUMBER} this CaseGuard understands.`,
      `Upgrade CaseGuard, or re-export the bundle for version ${CURRENT_VERSION_NUMBER}: remove fields added in later versions and set "schemaVersion" to "${CASE_BUNDLE_SCHEMA_VERSION}". Other fields were not checked because the schemas differ.`,
      shown,
    );
  }
  return issue(
    'schema_version_mismatch',
    path,
    `The bundle uses schema version ${version}, which is older than the current version ${CURRENT_VERSION_NUMBER}.`,
    `Migrate the file to the current schema (see docs/schemas/case-bundle.schema.json) and set "schemaVersion" to "${CASE_BUNDLE_SCHEMA_VERSION}". Other fields were not checked because the schemas differ.`,
    shown,
  );
}

function strictToIssue(error: StrictJsonError): ParseIssue {
  return {
    code: error.code,
    path: error.path,
    message: error.message,
    hint: error.hint,
    received: error.received,
    line: error.line,
  };
}

/**
 * Walks an already-parsed value iteratively and rejects what a JSON document could never contain
 * or what is unsafe to copy: over-deep nesting, too many values, prototype-pollution keys, NUL
 * and unpaired surrogates, non-finite numbers and non-JSON types.
 */
export function checkValueShape(
  root: unknown,
  limits: Pick<ParserLimits, 'maxJsonDepth' | 'maxJsonNodes'>,
): ParseIssue | null {
  const pending: { value: unknown; path: PathKey[]; depth: number }[] = [
    { value: root, path: [], depth: 1 },
  ];
  let nodes = 0;
  for (let item = pending.pop(); item; item = pending.pop()) {
    const { value, path, depth } = item;
    nodes += 1;
    if (nodes > limits.maxJsonNodes) {
      return issue(
        'json_too_complex',
        formatPath(path),
        `The JSON has more than ${limits.maxJsonNodes} values.`,
        'Split the file or remove unneeded data.',
      );
    }
    if (value === null || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (Number.isFinite(value)) continue;
      return issue(
        'json_invalid_number',
        formatPath(path),
        'A number is not finite.',
        'Use a finite number.',
        String(value),
      );
    }
    if (typeof value === 'string') {
      if (value.includes('\u0000') || LONE_SURROGATE.test(value)) {
        return issue(
          'json_invalid_string',
          formatPath(path),
          'A string contains a NUL character or an unpaired surrogate, which cannot be stored.',
          'Remove the character or re-export the file as UTF-8.',
        );
      }
      continue;
    }
    if (typeof value !== 'object') {
      return issue(
        'json_syntax',
        formatPath(path),
        'The value is not JSON data.',
        'Only strings, numbers, booleans, null, arrays and objects are allowed.',
        typeof value,
      );
    }
    if (depth > limits.maxJsonDepth) {
      return issue(
        'json_too_deep',
        formatPath(path),
        `The JSON is nested more than ${limits.maxJsonDepth} levels deep.`,
        'A case bundle needs only a few levels; flatten the structure.',
      );
    }
    if (Array.isArray(value)) {
      if (value.length > limits.maxJsonNodes) {
        return issue(
          'json_too_complex',
          formatPath(path),
          `An array has more than ${limits.maxJsonNodes} items.`,
          'Split the file.',
        );
      }
      value.forEach((child: unknown, index) =>
        pending.push({ value: child, path: [...path, index], depth: depth + 1 }),
      );
      continue;
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (FORBIDDEN_KEYS.has(key)) {
        return issue(
          'json_forbidden_key',
          formatPath(path),
          `The key "${key}" is not allowed because it can tamper with object prototypes.`,
          'Remove or rename the key.',
        );
      }
      pending.push({ value: record[key], path: [...path, key], depth: depth + 1 });
    }
  }
  return null;
}

interface UnknownField {
  path: string;
  key: string;
  suggestion: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Walks the value alongside the JSON Schema and collects keys the schema does not define. */
function collectUnknown(
  value: unknown,
  schema: unknown,
  path: PathKey[],
  found: UnknownField[],
): void {
  if (!isRecord(schema) || found.length >= 25) return;
  if (Array.isArray(value)) {
    const items = schema.items;
    if (items !== undefined) {
      value.forEach((child: unknown, i) => collectUnknown(child, items, [...path, i], found));
    }
    return;
  }
  const properties = schema.properties;
  if (!isRecord(value) || !isRecord(properties)) return;
  const known = Object.keys(properties);
  for (const key of Object.keys(value)) {
    if (Object.hasOwn(properties, key)) {
      collectUnknown(value[key], properties[key], [...path, key], found);
      continue;
    }
    const near = known.find(
      (k) =>
        k.toLowerCase() === key.toLowerCase() ||
        (key.length > 3 && levenshtein(k.toLowerCase(), key.toLowerCase()) <= 2),
    );
    found.push({ path: formatPath(path), key: displayValue(key, 30), suggestion: near ?? null });
  }
}

/** Fields the schema does not define are ignored by validation; report them so typos are not silent. */
function unknownFieldWarning(value: unknown, warnings: WarningCollector): void {
  const found: UnknownField[] = [];
  collectUnknown(value, caseBundleJsonSchema(), [], found);
  if (found.length === 0) return;
  const listed = found
    .slice(0, 5)
    .map(
      (f) => `"${f.key}" in ${f.path}${f.suggestion ? ` (did you mean "${f.suggestion}"?)` : ''}`,
    )
    .join('; ');
  warnings.add(
    'unknown_field',
    'warning',
    `${found.length} field(s) are not part of the case bundle schema and were ignored: ${listed}${found.length > 5 ? '; …' : ''}.`,
    { hint: 'Check the spelling against the JSON Schema.', count: found.length },
  );
}

function validate(
  value: unknown,
  limits: ParserLimits,
  warnings: WarningCollector,
  stats: { inputChars: number; inputBytes: number; lines: number },
): ParseResult {
  const base = { ...stats, events: 0, participants: 0, ignoredLines: 0, skippedRows: 0 };
  const failure = (errors: ParseIssue[]): DraftFailure => ({
    ok: false,
    source: 'json_bundle',
    errors,
    warnings: warnings.toArray(),
    stats: base,
  });
  if (!isRecord(value)) {
    return failure([
      issue(
        'json_not_an_object',
        '(root)',
        'The JSON must be an object describing one case.',
        BASE_HINT,
        describeReceived(value),
      ),
    ]);
  }
  const versionIssue = checkSchemaVersion(value.schemaVersion);
  if (versionIssue && value.schemaVersion !== undefined) return failure([versionIssue]);

  const target = versionIssue ? { ...value, schemaVersion: CASE_BUNDLE_SCHEMA_VERSION } : value;
  const parsed = CaseBundleSchema.safeParse(target);
  if (!parsed.success) {
    const errors = friendlyIssues(parsed.error.issues, value, limits.maxErrors);
    return failure(versionIssue ? [versionIssue, ...errors] : errors);
  }
  if (versionIssue) return failure([versionIssue]);
  unknownFieldWarning(value, warnings);
  const success: DraftSuccess = {
    ok: true,
    source: 'json_bundle',
    bundle: parsed.data,
    warnings: warnings.toArray(),
    confidence: JSON_CONFIDENCE,
    speakers: [],
    eventNotes: [],
    stats: {
      ...stats,
      events: parsed.data.events.length,
      participants: parsed.data.participants.length,
      ignoredLines: 0,
      skippedRows: 0,
    },
  };
  return success;
}

/**
 * Strict, bounded parse of a case bundle JSON document. Duplicate keys, prototype-pollution keys,
 * over-deep nesting and oversized payloads are rejected before schema validation, whose failures
 * are reported as friendly field-level errors (`path`, `message`, `hint`, `received`).
 *
 * @throws IngestParseError only when the *limits* option is invalid. Bad input never throws.
 */
export function parseCaseBundleJson(text: string, options: JsonBundleOptions = {}): ParseResult {
  const limits = resolveLimits(options.limits);
  const warnings = new WarningCollector(limits.maxWarnings);
  const stats = { inputChars: typeof text === 'string' ? text.length : 0, inputBytes: 0, lines: 0 };
  const fail = (
    code: ParseIssueCode,
    message: string,
    hint: string,
    received: string | null = null,
  ): DraftFailure => ({
    ok: false,
    source: 'json_bundle',
    errors: [issue(code, '(root)', message, hint, received)],
    warnings: warnings.toArray(),
    stats: { ...stats, events: 0, participants: 0, ignoredLines: 0, skippedRows: 0 },
  });

  if (typeof text !== 'string')
    return fail('input_not_text', 'The JSON content is missing or is not text.', BASE_HINT);
  if (exceedsBytes(text, limits.maxPayloadBytes)) {
    return fail(
      'input_too_large',
      `The JSON is larger than ${limits.maxPayloadBytes} bytes.`,
      'Split the case or remove unneeded data.',
      `${utf8Bytes(text)} bytes`,
    );
  }
  stats.inputBytes = utf8Bytes(text);
  let source = text;
  if (source.charCodeAt(0) === 0xfeff) {
    source = source.slice(1);
    warnings.add('bom_removed', 'info', 'A byte-order mark at the start of the file was ignored.');
  }
  const replaced = (source.match(/\uFFFD/g) ?? []).length;
  if (replaced > 0) {
    warnings.add(
      'invalid_characters_replaced',
      'warning',
      `The file contains ${replaced} replacement character(s) (�), which usually means it was not valid UTF-8.`,
      { hint: 'Re-export the file as UTF-8.', count: replaced },
    );
  }
  if (source.trim().length === 0)
    return fail('input_empty', 'The JSON content is empty.', BASE_HINT);
  stats.lines = (source.match(/\n/g) ?? []).length + 1;

  const parsed = parseStrictJson(source, {
    maxDepth: limits.maxJsonDepth,
    maxNodes: limits.maxJsonNodes,
  });
  if (!parsed.ok) {
    return {
      ok: false,
      source: 'json_bundle',
      errors: [strictToIssue(parsed.error)],
      warnings: warnings.toArray(),
      stats: { ...stats, events: 0, participants: 0, ignoredLines: 0, skippedRows: 0 },
    };
  }
  return validate(parsed.value, limits, warnings, stats);
}

/**
 * Same validation for a value that was already parsed elsewhere (for example a request body):
 * checks depth, size and unsafe keys iteratively, then validates against the schema.
 */
export function validateCaseBundleValue(
  value: unknown,
  options: JsonBundleOptions = {},
): ParseResult {
  const limits = resolveLimits(options.limits);
  const warnings = new WarningCollector(limits.maxWarnings);
  const stats = { inputChars: 0, inputBytes: 0, lines: 0 };
  const shape = checkValueShape(value, limits);
  if (shape) {
    return {
      ok: false,
      source: 'json_bundle',
      errors: [shape],
      warnings: warnings.toArray(),
      stats: { ...stats, events: 0, participants: 0, ignoredLines: 0, skippedRows: 0 },
    };
  }
  return validate(value, limits, warnings, stats);
}
