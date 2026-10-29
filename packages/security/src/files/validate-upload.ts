import { sha256Hex } from '../hashing';
import { checkFileName, type UploadIssue, type UploadIssueCode } from './filename';
import {
  decodeUploadText,
  detectBinarySignature,
  hasUtf16ByteOrderMark,
  looksBinary,
  looksLikeActiveContent,
} from './signatures';

export type UploadKind = 'json' | 'text' | 'csv' | 'markdown';

export interface UploadInput {
  /** File name as sent by the client; treated as hostile. */
  fileName: string;
  /** Content-Type of the part, if any; treated as hostile. */
  mediaType?: string | null | undefined;
  bytes: Uint8Array;
  /** Largest accepted size in bytes (UPLOAD_MAX_BYTES). */
  maxBytes: number;
}

export interface UploadCheckResult {
  readonly ok: boolean;
  /** Derived from the extension. Only trust it when `ok` is true. */
  readonly kind: UploadKind | null;
  /** Always present and always safe to store or echo, even when the upload is rejected. */
  readonly safeFileName: string;
  readonly issues: UploadIssue[];
  /** SHA-256 of the raw bytes (before BOM stripping), recorded for audit and de-duplication. */
  readonly sha256: string;
}

export type { UploadIssue, UploadIssueCode } from './filename';

const EXTENSION_KINDS: Readonly<Record<string, UploadKind>> = {
  json: 'json',
  txt: 'text',
  log: 'text',
  md: 'markdown',
  csv: 'csv',
};

/** Media types accepted per kind. `text/plain` is what most clients send for any text file. */
const MEDIA_TYPES: Readonly<Record<UploadKind, readonly string[]>> = {
  json: ['application/json', 'text/json', 'application/x-json', 'text/plain'],
  text: ['text/plain', 'text/x-log', 'application/x-log'],
  markdown: ['text/markdown', 'text/x-markdown', 'text/plain'],
  // Windows browsers label CSV files application/vnd.ms-excel.
  csv: ['text/csv', 'application/csv', 'application/vnd.ms-excel', 'text/plain'],
};
const ALL_MEDIA_TYPES = new Set(Object.values(MEDIA_TYPES).flat());
/** "I do not know": browsers send these for extensions the OS has no mapping for (.md, .log). */
const UNSPECIFIED_MEDIA_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);
const ACCEPTED_CHARSETS = new Set(['utf-8', 'utf8', 'us-ascii', 'ascii']);

const MAX_JSON_DEPTH = 64;

/** Deepest bracket nesting outside strings; stops counting once `limit` is exceeded. */
function jsonNesting(text: string, limit: number): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (code === 0x5c) escaped = true;
      else if (code === 0x22) inString = false;
    } else if (code === 0x22) {
      inString = true;
    } else if (code === 0x5b || code === 0x7b) {
      depth += 1;
      if (depth > max) max = depth;
      if (max > limit) return max;
    } else if (code === 0x5d || code === 0x7d) {
      depth -= 1;
    }
  }
  return max;
}

function checkMediaType(
  rawMediaType: string | null | undefined,
  kind: UploadKind | null,
  add: (code: UploadIssueCode, message: string) => void,
): void {
  if (rawMediaType === null || rawMediaType === undefined) return;
  const [rawType = '', ...parameters] = rawMediaType.split(';');
  const type = rawType.trim().toLowerCase();
  if (
    rawMediaType.length > 200 ||
    (type !== '' && !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(type))
  ) {
    add('media_type_malformed', 'The Content-Type header is not a valid media type');
    return;
  }
  for (const parameter of parameters) {
    const [key = '', ...rest] = parameter.split('=');
    if (key.trim().toLowerCase() !== 'charset') continue;
    const charset = rest.join('=').trim().replace(/^"|"$/g, '').toLowerCase();
    if (!ACCEPTED_CHARSETS.has(charset)) {
      add('charset_not_supported', 'Only UTF-8 (or ASCII) text is accepted');
    }
  }
  if (UNSPECIFIED_MEDIA_TYPES.has(type)) return;
  if (!ALL_MEDIA_TYPES.has(type)) {
    add('media_type_not_allowed', 'The media type is not an accepted text format');
  } else if (kind !== null && !MEDIA_TYPES[kind].includes(type)) {
    add('media_type_mismatch', 'The media type does not match the file extension');
  }
}

function checkContent(
  bytes: Uint8Array,
  kind: UploadKind | null,
  add: (code: UploadIssueCode, message: string) => void,
): void {
  const signature = detectBinarySignature(bytes);
  if (signature !== null) {
    add('executable_or_archive_signature', `The content is a ${signature}, not text`);
    return;
  }
  if (hasUtf16ByteOrderMark(bytes)) {
    add('unsupported_encoding', 'UTF-16 text is not accepted; save the file as UTF-8');
    return;
  }
  if (looksBinary(bytes)) {
    add('binary_content', 'The content is binary (NUL or control bytes), not text');
    return;
  }
  let text: string;
  try {
    text = decodeUploadText(bytes);
  } catch {
    add('invalid_utf8', 'The content is not valid UTF-8');
    return;
  }
  if (looksLikeActiveContent(text)) {
    add('active_content', 'The content looks like a web page or script, not a data file');
  }
  if (kind !== 'json') return;
  if (jsonNesting(text, MAX_JSON_DEPTH) > MAX_JSON_DEPTH) {
    add('json_too_deep', `JSON is nested deeper than ${MAX_JSON_DEPTH} levels`);
    return;
  }
  try {
    JSON.parse(text);
  } catch {
    // The parser's message can quote the input, so it is deliberately not forwarded.
    add('invalid_json', 'The file is not valid JSON');
  }
}

/**
 * Validates an upload before anything reads it (FR-ING-05, NFR-SEC-04). Checks the file name, the
 * extension and Content-Type allowlists and their consistency, the size, binary/executable
 * signatures, UTF-8 validity and, for JSON, syntax and nesting depth. Collects every problem it
 * finds instead of stopping at the first. Content problems are decided from the bytes alone, so a
 * hostile name or Content-Type can never talk the validator into accepting a binary.
 */
export function validateUpload(input: UploadInput): UploadCheckResult {
  if (!Number.isInteger(input.maxBytes) || input.maxBytes <= 0) {
    throw new RangeError('maxBytes must be a positive integer');
  }
  const issues: UploadIssue[] = [];
  const add = (code: UploadIssueCode, message: string): void => {
    issues.push({ code, message });
  };

  const name = checkFileName(input.fileName);
  issues.push(...name.issues);

  const kind = EXTENSION_KINDS[name.extension] ?? null;
  if (kind === null) {
    add('extension_not_allowed', 'Only .json, .txt, .log, .md and .csv files are accepted');
  }

  checkMediaType(input.mediaType, kind, add);

  if (input.bytes.length === 0) add('empty_file', 'The file is empty');
  else if (input.bytes.length > input.maxBytes) {
    add('file_too_large', `The file is larger than the ${input.maxBytes}-byte limit`);
  } else {
    checkContent(input.bytes, kind, add);
  }

  return {
    ok: issues.length === 0 && kind !== null,
    kind,
    safeFileName: name.safeFileName,
    issues,
    sha256: sha256Hex(input.bytes),
  };
}
