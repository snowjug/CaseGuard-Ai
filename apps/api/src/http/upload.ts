import type { FastifyReply, FastifyRequest } from 'fastify';
import { sha256Hex } from '@caseguard/security';
import {
  AppError,
  MalformedRequestError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  ValidationFailedError,
} from '../errors';

export interface UploadedFile {
  /** Name sent by the client. Hostile: run it through the security package before storing or echoing. */
  readonly fileName: string;
  readonly mediaType: string | null;
  readonly bytes: Buffer;
  readonly sha256: string;
  /**
   * The workload the person chose for the file (the optional `workload` text field of the form), trimmed.
   * Null when none was sent. A CSV file cannot state its own, so the pipeline refuses one that has none.
   */
  readonly workload: string | null;
}

/** Longest workload key (the same bound the JSON sources use). */
export const WORKLOAD_FIELD_MAX = 80;

/** Room for the multipart framing (boundaries, part headers, the few small form fields) around the file. */
const FRAMING_ALLOWANCE_BYTES = 32 * 1024;

function declaredLength(request: FastifyRequest): number | null {
  const raw = request.headers['content-length'];
  return typeof raw === 'string' && /^\d{1,15}$/.test(raw) ? Number(raw) : null;
}

/**
 * Parser and stream failures while reading an upload are the client's: a broken envelope or an upload
 * cut short is a 400, never a server fault. Errors the multipart plugin already shaped for the
 * client (`FST_*`, with a 4xx status) keep their meaning.
 */
function translateUploadError(error: unknown, refuse: () => PayloadTooLargeError): unknown {
  if (error instanceof AppError) return error;
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : null;
  if (code === 'FST_REQ_FILE_TOO_LARGE') return refuse();
  if (typeof code === 'string' && code.startsWith('FST_')) return error;
  return new MalformedRequestError('The multipart body could not be read');
}

/** The `workload` form field: trimmed; empty means none; anything that is not a short plain key is refused. */
function workloadOf(value: unknown, truncated: boolean): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '' && !truncated) return null;
  if (truncated || text.length > WORKLOAD_FIELD_MAX || /\p{Cc}/u.test(text)) {
    throw new ValidationFailedError('The workload is not valid', [
      {
        path: 'workload',
        message: `A workload key is a short word of at most ${WORKLOAD_FIELD_MAX} characters`,
      },
    ]);
  }
  return text;
}

/**
 * Reads the single file of a multipart request into memory, never more than `maxBytes`, together with its
 * optional `workload` text field.
 *
 * - A declared `content-length` far beyond the limit is refused before a byte is read.
 * - The size limit is enforced by the parser, which truncates at the limit. `toBuffer` only throws
 *   when a chunk arrives after the cut, so an upload that ends exactly at a chunk boundary is flagged
 *   `truncated` without an error: the flag is checked explicitly so evidence is never stored cut short.
 * - Every refusal for size closes the connection after the answer, so the rest of the body is not drained.
 */
export async function readUpload(
  request: FastifyRequest,
  response: FastifyReply,
  maxBytes: number,
): Promise<UploadedFile> {
  if (!request.isMultipart()) {
    throw new UnsupportedMediaTypeError(
      'Send multipart/form-data with one file in the "file" field',
    );
  }
  const refuse = (): PayloadTooLargeError => {
    void response.header('connection', 'close');
    return new PayloadTooLargeError(
      `The file is larger than the ${maxBytes} byte upload limit`,
      maxBytes,
    );
  };
  const declared = declaredLength(request);
  if (declared !== null && declared > maxBytes + FRAMING_ALLOWANCE_BYTES) throw refuse();

  let file: { fileName: string; mediaType: string | null; bytes: Buffer } | undefined;
  let workload: string | null = null;
  try {
    // Every part is read, in whatever order the client sent them, so that the optional `workload` text field may
    // come before or after the file. Any other text field is ignored.
    for await (const part of request.parts({ limits: { fileSize: maxBytes, files: 1 } })) {
      if (part.type === 'field') {
        if (part.fieldname === 'workload') workload = workloadOf(part.value, part.valueTruncated);
        continue;
      }
      if (part.fieldname !== 'file') {
        // Left unread, the stream would hold the connection open until the request times out.
        part.file.destroy();
        throw new ValidationFailedError('The file must be sent in the "file" field', [
          { path: part.fieldname.slice(0, 40), message: 'Unexpected field name' },
        ]);
      }
      const bytes = await part.toBuffer();
      if (part.file.truncated) throw refuse();
      file = {
        fileName: part.filename,
        mediaType: part.mimetype === '' ? null : part.mimetype,
        bytes,
      };
    }
  } catch (error) {
    throw translateUploadError(error, refuse);
  }
  if (file === undefined) {
    throw new ValidationFailedError('No file was uploaded', [
      { path: 'file', message: 'Attach one file in the "file" field' },
    ]);
  }
  return { ...file, sha256: sha256Hex(file.bytes), workload };
}
