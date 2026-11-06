import type { ApiIssue } from '../../lib/api/errors';
import { ApiError, describeError } from '../../lib/api/errors';
import type { SourceChoice } from './ingest-source';

/** How an ingestion failure is explained to the person: what happened, what to do, and any field-level issues. */
export interface IngestProblem {
  kind:
    | 'too_large'
    | 'unsupported_type'
    | 'invalid'
    | 'unsafe'
    | 'file_refused'
    | 'redaction_incomplete'
    | 'reference_in_use'
    | 'in_progress'
    | 'conflict'
    | 'rate_limited'
    | 'budget'
    | 'forbidden'
    | 'not_found'
    | 'key_reuse'
    | 'unavailable'
    | 'other';
  /** `info` is a calm notice (the work is already under way); `error` is a refusal or a failure. */
  tone: 'error' | 'info';
  title: string;
  message: string;
  /** What the person can do next. */
  advice: string;
  issues: readonly ApiIssue[];
  /** Seconds to wait before retrying (rate limit, request still running), when known. */
  retryAfterSeconds: number | null;
  correlationId: string | undefined;
  /** Retrying the same request can succeed (transient or rate-limited). */
  retryable: boolean;
  /** The reference that is already taken (`reference_in_use`), when the API named it. */
  reference: string | null;
  /** Labels of the workspace's custom redaction patterns that could not be applied (`redaction_incomplete`). */
  patternLabels: readonly string[];
}

const ALLOWED_FILES = '.json, .txt, .log, .md or .csv';

/** Seconds before "Try again" is offered for a request that is still running on the server. */
const IN_PROGRESS_WAIT_SECONDS = 3;

const NO_DETAIL = { reference: null, patternLabels: [] } as const;

/**
 * The stable `Problem.reason` tokens (`ApiError.reason`, see docs/API.md) that tell the refusals of the ingestion routes
 * apart: two 409s and the two causes of a 422 `unsafe_content`. The message is never what decides: it only supplies the
 * name of the reference and the labels of the redaction patterns, which no token carries.
 */
export const INGEST_REASONS = {
  /** 409: another case of the workspace already uses the reference, with different content. */
  referenceInUse: 'reference_in_use',
  /** 409: the same Idempotency-Key is still being processed by an earlier, identical request. */
  requestInProgress: 'request_in_progress',
  /** 422 `unsafe_content`: an uploaded file was refused (its validation, the malware scanner, invalid UTF-8). */
  fileRefused: 'file_refused',
  /** 422 `unsafe_content`: a custom redaction pattern could not be applied, so the content is refused (fail closed). */
  redactionIncomplete: 'redaction_incomplete',
} as const;

/**
 * Takes the reference out of the API's wording of a taken reference ("A case with reference CG-X-1 already exists in
 * this workspace with different content", or the shorter "A case with this reference already exists"): `reference` is
 * null when the message does not name it, and the result is null when the message is something else.
 *
 * A create names the condition by its `reason` token (`INGEST_REASONS.referenceInUse`), so this is only used to read the
 * name out of that answer. A preview has no such token: it reports the same refusal as an error issue on path
 * `case.reference` (a path that also carries ordinary field errors), so there the wording is what identifies it.
 */
export function referenceInUseOf(message: string): { reference: string | null } | null {
  const match = /case with (?:reference ([A-Za-z0-9][\w.-]*)|this reference) already exists/i.exec(
    message,
  );
  return match ? { reference: match[1] ?? null } : null;
}

/**
 * Labels of the custom redaction patterns that a redaction refusal names (`custom redaction pattern "Customer ids" could
 * not be applied`): the 422 of a create (reason `redaction_incomplete`) and the issue on path `redaction` of a preview
 * carry the same sentence. Neither has a field for the labels, so they are read out of it; none are returned when the
 * sentence names none. Only labels are ever named: never a pattern's source or any of the payload.
 */
export function redactionPatternLabels(message: string): string[] {
  return [...message.matchAll(/"([^"]{1,120})"/g)].flatMap((match) => (match[1] ? [match[1]] : []));
}

/** Why the content was refused when a custom redaction pattern could not be applied. */
export function describeRedactionRefusal(labels: readonly string[]): string {
  const subject =
    labels.length === 0
      ? 'custom redaction pattern'
      : labels.length === 1
        ? `custom redaction pattern "${labels[0]}"`
        : `custom redaction patterns ${labels.map((label) => `"${label}"`).join(', ')}`;
  return `The workspace's ${subject} could not be applied, so CaseGuard refuses the content rather than store it partly redacted.`;
}

export const REDACTION_REFUSAL_ADVICE =
  'Ask an administrator to fix the pattern in Governance > Redaction, then check again.';

/** What to do about a reference that is taken, which depends on whether the person wrote the payload. */
function referenceAdvice(source: SourceChoice | undefined): string {
  switch (source) {
    case 'bundle':
      return 'Change "case.reference" in your bundle to one this workspace does not use yet, or ask an administrator to delete the existing case first.';
    case 'sample':
      return "This sample's reference is held by a different case, so it cannot be created again. Find that case in the Cases list; an administrator can delete it first.";
    default:
      return 'Pasted text and files have no reference field, so the reference is generated from the content. Find the existing case in the Cases list; an administrator can delete it first.';
  }
}

/**
 * Maps every error the ingestion routes document to an honest, specific explanation: 413 too large, 415 unsupported
 * type, 422 invalid, 422 unsafe (a refused file, or a custom redaction pattern that could not be applied), the three
 * kinds of 409 (reference already in use, same request still running, anything else), 422 for a request key reused with
 * different content, 429 with `Retry-After`, 403, plus unreachable API and anything unexpected. The conditions are told
 * apart by the API's `code` and `reason` token (docs/API.md), never by its wording; the only wording read is the name of
 * a taken reference and the labels of the redaction patterns, which no token carries. A problem that names no reason
 * keeps its generic explanation. The API's own message is kept wherever it carries the limits. `source` tailors the
 * advice to what the person actually provided.
 */
export function explainIngestError(error: unknown, source?: SourceChoice): IngestProblem {
  if (!(error instanceof ApiError)) {
    return {
      ...NO_DETAIL,
      tone: 'error',
      kind: 'other',
      title: 'The case could not be processed',
      message: describeError(error),
      advice: 'Try again. If it keeps failing, quote the correlation id to support.',
      issues: [],
      retryAfterSeconds: null,
      correlationId: undefined,
      retryable: true,
    };
  }
  const base = {
    ...NO_DETAIL,
    tone: 'error' as const,
    issues: error.issues,
    correlationId: error.correlationId,
  };
  const retryAfterSeconds =
    error.retryAfterMs === undefined ? null : Math.max(1, Math.ceil(error.retryAfterMs / 1000));

  if (error.status === 413 || error.code === 'payload_too_large') {
    return {
      ...base,
      kind: 'too_large',
      title: 'That is larger than the API accepts',
      message: error.message,
      advice:
        'Shorten the pasted text or split the case, then try again. The limit is set by the server.',
      retryAfterSeconds: null,
      retryable: false,
    };
  }
  if (error.status === 415 || error.code === 'unsupported_media_type') {
    return {
      ...base,
      kind: 'unsupported_type',
      title: 'That file type is not supported',
      message: error.message,
      advice: `Use a ${ALLOWED_FILES} file, or paste the content instead.`,
      retryAfterSeconds: null,
      retryable: false,
    };
  }
  if (error.code === 'unsafe_content') {
    // The reason token says which safety check refused the content. Neither the source nor the wording is what decides.
    if (error.reason === INGEST_REASONS.redactionIncomplete) {
      const labels = redactionPatternLabels(error.message);
      return {
        ...base,
        kind: 'redaction_incomplete',
        patternLabels: labels,
        title: 'Redaction could not be completed',
        message: describeRedactionRefusal(labels),
        advice: REDACTION_REFUSAL_ADVICE,
        retryAfterSeconds: null,
        retryable: false,
      };
    }
    if (error.reason === INGEST_REASONS.fileRefused) {
      return {
        ...base,
        kind: 'file_refused',
        title: 'The file was refused for safety reasons',
        message: error.message,
        advice:
          'Remove anything that is not plain text (executable, binary or active content), save the file as UTF-8 and upload it again, or paste the text instead.',
        retryAfterSeconds: null,
        retryable: false,
      };
    }
    // A refusal that names no cause: nothing is assumed about it, neither a file nor a redaction pattern.
    return {
      ...base,
      kind: 'unsafe',
      title: 'The content was refused for safety reasons',
      message: error.message,
      advice:
        'A safety check refused the content and nothing was stored. Make sure it is plain case text and try again; if it is refused again, ask an administrator and quote the support reference below.',
      retryAfterSeconds: null,
      retryable: false,
    };
  }
  if (error.code === 'idempotency_conflict') {
    return {
      ...base,
      kind: 'key_reuse',
      title: 'That request key was already used for different content',
      message:
        'The request key of this attempt was already used by a request that was not identical, so the server refused it rather than guess which one you meant. Nothing was created.',
      advice: 'Press the button again: a fresh request key is used for the new attempt.',
      retryAfterSeconds: null,
      retryable: true,
    };
  }
  if (error.status === 422 || error.code === 'validation_failed') {
    return {
      ...base,
      kind: 'invalid',
      title: 'The payload is not valid',
      message: error.message,
      advice: 'Fix the fields listed below, then check again.',
      retryAfterSeconds: null,
      retryable: false,
    };
  }
  if (error.status === 409 || error.code === 'conflict') {
    if (error.reason === INGEST_REASONS.requestInProgress) {
      return {
        ...base,
        tone: 'info',
        kind: 'in_progress',
        title: 'This request is already being processed',
        message:
          'An identical request is still running, so a second one was not started. Nothing is lost and nothing is duplicated.',
        advice:
          'Wait a moment and check the Cases list: the case appears there as soon as the first request finishes.',
        retryAfterSeconds: IN_PROGRESS_WAIT_SECONDS,
        retryable: true,
      };
    }
    if (error.reason === INGEST_REASONS.referenceInUse) {
      // The token says what happened; only the name of the reference is read from the message (it may not name it).
      const reference = referenceInUseOf(error.message)?.reference ?? null;
      return {
        ...base,
        kind: 'reference_in_use',
        reference,
        title: reference
          ? `A case with reference ${reference} already exists`
          : 'A case with this reference already exists',
        message: `${
          reference
            ? `A case with reference ${reference} already exists in this workspace with different content.`
            : 'A case with this reference already exists in this workspace.'
        } Use a different case reference, or delete the existing case first.`,
        advice: referenceAdvice(source),
        retryAfterSeconds: null,
        retryable: false,
      };
    }
    return {
      ...base,
      kind: 'conflict',
      title: 'The request conflicts with the current state',
      message: error.message,
      advice:
        'Reload the page and try again. If it keeps happening, quote the support reference below when you contact support.',
      retryAfterSeconds: null,
      retryable: false,
    };
  }
  if (error.status === 429 && error.code === 'budget_exceeded') {
    return {
      ...base,
      kind: 'budget',
      title: 'A processing budget was reached',
      message: error.message,
      advice:
        'The request was refused rather than cut short. Try again later or ask an administrator.',
      retryAfterSeconds,
      retryable: retryAfterSeconds !== null,
    };
  }
  if (error.status === 429) {
    return {
      ...base,
      kind: 'rate_limited',
      title: 'Too many requests',
      message: error.message,
      advice:
        retryAfterSeconds === null
          ? 'Wait a moment, then try again.'
          : `The server asks you to wait ${retryAfterSeconds} ${retryAfterSeconds === 1 ? 'second' : 'seconds'} before trying again.`,
      retryAfterSeconds,
      retryable: true,
    };
  }
  if (error.isForbidden) {
    return {
      ...base,
      kind: 'forbidden',
      title: 'Your role cannot do this',
      message: error.message,
      advice: 'Adding cases needs the Engineer or Administrator role.',
      retryAfterSeconds: null,
      retryable: false,
    };
  }
  if (error.isNotFound) {
    return {
      ...base,
      kind: 'not_found',
      title: 'That item no longer exists',
      message: error.message,
      advice: 'Go back and choose again.',
      retryAfterSeconds: null,
      retryable: false,
    };
  }
  if (error.isNetwork || error.isUnavailable || error.isTimeout || error.isMisconfigured) {
    return {
      ...base,
      kind: 'unavailable',
      title: error.isMisconfigured
        ? 'The CaseGuard API is not configured'
        : 'The CaseGuard API is not reachable',
      message: describeError(error),
      advice: error.isMisconfigured
        ? 'Ask an administrator to fix the server setup.'
        : 'Retry in a moment.',
      retryAfterSeconds: null,
      retryable: !error.isMisconfigured,
    };
  }
  return {
    ...base,
    kind: 'other',
    title: 'The case could not be processed',
    message: describeError(error),
    advice: 'Try again. If it keeps failing, quote the correlation id to support.',
    retryAfterSeconds: null,
    retryable: error.status >= 500,
  };
}
