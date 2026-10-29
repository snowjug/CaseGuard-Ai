export type IngestErrorCode = 'invalid_options';

/**
 * Thrown only for programmer mistakes (invalid options or limits). Problems with the *input* are
 * returned as a `DraftFailure`, never thrown, so callers can show them next to the preview.
 */
export class IngestParseError extends Error {
  readonly code: IngestErrorCode;

  constructor(code: IngestErrorCode, message: string) {
    super(message);
    this.name = 'IngestParseError';
    this.code = code;
  }
}
