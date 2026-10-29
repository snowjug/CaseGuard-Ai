import type { Scrubber } from '../redaction/scrubber';

const MAX_DETAIL_LENGTH = 200;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,40}$/;

/**
 * One-line, secret-free description of a failed check: `CODE: message` when the error carries a
 * short machine code (ECONNREFUSED, ETIMEDOUT), never a stack, with secrets and PII scrubbed and the
 * length capped. The raw error should go to the logger, which applies the same scrubbing.
 */
export function sanitizeErrorDetail(error: unknown, scrubber: Scrubber): string {
  const info = scrubber.error(error);
  const message = info.message.replace(/\s+/g, ' ').trim();
  const base = message === '' ? info.type : message;
  const code =
    typeof info.code === 'string' && CODE_PATTERN.test(info.code) ? info.code : undefined;
  const text = code !== undefined && !base.includes(code) ? `${code}: ${base}` : base;
  return text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH - 1)}…` : text;
}
