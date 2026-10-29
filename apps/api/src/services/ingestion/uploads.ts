import type { ValidationIssue } from '@caseguard/schemas';
import {
  decodeUploadText,
  validateUpload,
  type MalwareScanner,
  type UploadIssue,
  type UploadIssueCode,
  type UploadKind,
} from '@caseguard/security';
import {
  PayloadTooLargeError,
  UnsafeContentError,
  UnsupportedMediaTypeError,
  ValidationFailedError,
  type AppError,
} from '../../errors';
import type { IngestUpload } from '../ports';
import { warningIssue } from './issues';

/** Syntax problems the strict JSON parser explains better (line, column, hint) than the upload check. */
const EXPLAINED_BY_PARSER: ReadonlySet<UploadIssueCode> = new Set([
  'invalid_json',
  'json_too_deep',
]);

/** Wrong kind of file (extension or Content-Type): a 415, the request itself is unsupported. */
const TYPE_CODES: ReadonlySet<UploadIssueCode> = new Set([
  'extension_not_allowed',
  'media_type_malformed',
  'media_type_not_allowed',
  'media_type_mismatch',
  'charset_not_supported',
]);

const SIGNATURE_NAME = /^[A-Za-z0-9._:-]{1,60}$/;

export interface PreparedUpload {
  readonly kind: UploadKind;
  readonly text: string;
  /** Storage-safe name derived from the client's; the original is never stored or echoed. */
  readonly safeFileName: string;
  /** Honest remarks about what was (not) checked, for the preview. */
  readonly notes: ValidationIssue[];
}

export interface UploadEnv {
  readonly uploadMaxBytes: number;
  readonly scanner: MalwareScanner;
}

/** Maps the upload check's verdict to the HTTP problem the contract documents (413, 415, 422). */
export function uploadRefusal(issues: readonly UploadIssue[], maxBytes: number): AppError {
  const messages = issues.map((issue) => issue.message).join('; ');
  if (issues.some((issue) => issue.code === 'file_too_large')) {
    return new PayloadTooLargeError(`The file is larger than the ${maxBytes}-byte limit`, maxBytes);
  }
  if (issues.some((issue) => TYPE_CODES.has(issue.code))) {
    return new UnsupportedMediaTypeError(messages);
  }
  if (issues.some((issue) => issue.code === 'empty_file')) {
    return new ValidationFailedError('The file is empty', [
      { path: 'file', message: 'Upload a file that contains a case' },
    ]);
  }
  return new UnsafeContentError(`The file was refused: ${messages}.`);
}

/**
 * Checks an upload before anything reads it: name, extension and Content-Type allowlists, size, binary
 * and executable signatures, UTF-8, then the malware scanner hook. Decisions come from the bytes, never
 * from the name or Content-Type the client claims. Refusals are 413 / 415 / 422 problems; a JSON
 * syntax error is not one (the parser reports it with its position in a normal preview).
 */
export async function prepareUpload(file: IngestUpload, env: UploadEnv): Promise<PreparedUpload> {
  const check = validateUpload({
    fileName: file.fileName,
    mediaType: file.mediaType,
    bytes: file.bytes,
    maxBytes: env.uploadMaxBytes,
  });
  const blocking = check.issues.filter((issue) => !EXPLAINED_BY_PARSER.has(issue.code));
  if (check.kind === null || blocking.length > 0) {
    throw uploadRefusal(blocking.length > 0 ? blocking : check.issues, env.uploadMaxBytes);
  }

  const scan = await env.scanner.scan(file.bytes);
  if (scan.status === 'infected') {
    const signature =
      scan.signature !== null && SIGNATURE_NAME.test(scan.signature) ? ` (${scan.signature})` : '';
    throw new UnsafeContentError(`The file was refused by the malware scanner${signature}.`);
  }

  let text: string;
  try {
    text = decodeUploadText(file.bytes);
  } catch {
    throw new UnsafeContentError('The file was refused: the content is not valid UTF-8.');
  }
  return {
    kind: check.kind,
    text,
    safeFileName: check.safeFileName,
    notes: [warningIssue('file', scan.detail)],
  };
}
