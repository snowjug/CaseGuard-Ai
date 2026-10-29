import { ValidationFailedError } from '../errors';
import { sha256Hex } from './hash';

/**
 * Opaque keyset-pagination cursors: `base64url(JSON [version, kind, ...sortKeyValues]).checksum`.
 *
 * The checksum is an integrity check, not a secret: it rejects corrupted or hand-edited cursors and a
 * cursor minted for one list cannot be replayed against another (the kind is part of the payload).
 * A forged-but-well-formed cursor can only move the caller's position inside data the caller may
 * already read, because every list query is parameterised and filtered by tenant.
 */
export type CursorKind =
  'cases' | 'events' | 'claims' | 'skills' | 'audit' | 'executions' | 'reviews' | 'jobs';

export type CursorField = 'timestamp' | 'text' | 'int';
export type CursorValue = string | number;

const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 400;
const MAX_TEXT_LENGTH = 200;
const CHECKSUM_LENGTH = 8;
const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function invalidCursor(): ValidationFailedError {
  return new ValidationFailedError('The pagination cursor is invalid', [
    { path: 'cursor', message: 'The cursor is malformed or was issued for a different list' },
  ]);
}

function checksum(kind: CursorKind, payload: string): string {
  return sha256Hex(`${kind}:${payload}`).slice(0, CHECKSUM_LENGTH);
}

export function encodeCursor(kind: CursorKind, values: readonly CursorValue[]): string {
  const payload = JSON.stringify([CURSOR_VERSION, kind, ...values]);
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${checksum(kind, payload)}`;
}

/**
 * Decodes and validates a cursor. Returns null when there is no cursor; throws
 * ValidationFailedError for anything that is not exactly what `encodeCursor` produced for `kind`
 * with the given field layout.
 */
export function decodeCursor(
  kind: CursorKind,
  cursor: string | undefined,
  fields: readonly CursorField[],
): CursorValue[] | null {
  if (cursor === undefined || cursor === '') return null;
  if (cursor.length > MAX_CURSOR_LENGTH) throw invalidCursor();
  const parts = cursor.split('.');
  const [encoded, tag] = parts;
  if (parts.length !== 2 || !encoded || !tag || !/^[0-9a-f]+$/.test(tag)) throw invalidCursor();
  const bytes = Buffer.from(encoded, 'base64url');
  // Re-encoding rejects non-canonical base64url spellings of the same bytes.
  if (bytes.toString('base64url') !== encoded) throw invalidCursor();
  const payload = bytes.toString('utf8');
  if (checksum(kind, payload) !== tag) throw invalidCursor();

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw invalidCursor();
  }
  if (!Array.isArray(parsed) || parsed.length !== fields.length + 2) throw invalidCursor();
  if (parsed[0] !== CURSOR_VERSION || parsed[1] !== kind) throw invalidCursor();

  const values: CursorValue[] = [];
  fields.forEach((field, index) => {
    const value: unknown = parsed[index + 2];
    switch (field) {
      case 'timestamp':
        if (typeof value !== 'string' || !ISO_MILLIS.test(value)) throw invalidCursor();
        if (Number.isNaN(Date.parse(value))) throw invalidCursor();
        values.push(value);
        break;
      case 'text':
        if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH) throw invalidCursor();
        values.push(value);
        break;
      case 'int':
        if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw invalidCursor();
        values.push(value);
        break;
    }
  });
  return values;
}

export const MAX_PAGE_SIZE = 200;

/** Validates a page size; callers pass values that already went through the HTTP schema. */
export function normalizeLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new ValidationFailedError(`limit must be an integer between 1 and ${MAX_PAGE_SIZE}`, [
      { path: 'limit', message: `Use a value between 1 and ${MAX_PAGE_SIZE}` },
    ]);
  }
  return limit;
}

/** Splits a `limit + 1` fetch into a page and the cursor of its last item. */
export function toPage<Row, Item>(
  rows: readonly Row[],
  limit: number,
  mapItem: (row: Row) => Item,
  cursorOf: (row: Row) => string,
): { items: Item[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    items: pageRows.map(mapItem),
    nextCursor: hasMore && last !== undefined ? cursorOf(last) : null,
  };
}
