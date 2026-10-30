import type {
  CaseBundle,
  IngestionPreview,
  RedactionCategory,
  RedactionConfig,
  SourceKind,
} from '@caseguard/schemas';
import type {
  CustomPatternBudget,
  MalwareScanner,
  RedactionIncompleteError,
} from '@caseguard/security';

/** Everything the pipeline needs from its caller; the pipeline itself never touches the database. */
export interface PipelineEnv {
  /** Injected instant (UTC ISO-8601): date of time-only stamps and reference of the future-date check. */
  readonly now: string;
  /** The tenant holds synthetic data only; pasted text and CSV inherit this label (they carry none). */
  readonly tenantSynthetic: boolean;
  readonly redaction: RedactionConfig;
  readonly uploadMaxBytes: number;
  readonly scanner: MalwareScanner;
  /**
   * The request's allowance of custom-pattern evaluation time, shared by every redaction call of it.
   * Omit it: the pipeline then makes one with the security package's default (3 s) for each request.
   * Tests pass one that is already used up, or a fake, to make a pattern fail on purpose.
   */
  readonly customPatternBudget?: CustomPatternBudget;
}

/** Which categories of a redaction fired inside one event (counts and categories only, never text). */
export interface EventRedaction {
  readonly redacted: boolean;
  readonly categories: RedactionCategory[];
}

/** A payload that passed every check: exactly what is going to be stored. */
export interface PreparedPayload {
  /** The bundle after redaction. */
  readonly bundle: CaseBundle;
  /** Canonical JSON of the redacted bundle: what is stored, hashed and mirrored to the object store. */
  readonly storedPayload: string;
  /** SHA-256 of `storedPayload`: the idempotency key of ingestion. */
  readonly contentHash: string;
  readonly sourceKind: SourceKind;
  /** Sanitised name of the uploaded or built-in file; null for pasted text and JSON bodies. */
  readonly fileName: string | null;
  /** Null-prototype map: event ids come from the payload and may be called "constructor". */
  readonly redactionByEventId: Record<string, EventRedaction>;
}

export interface PipelineOutcome {
  /** `alreadyIngestedCaseId` is always null here; the caller looks it up (the pipeline has no database). */
  readonly preview: IngestionPreview;
  /** Present exactly when `preview.ok`. */
  readonly prepared: PreparedPayload | null;
  /** Operator-facing remarks (never payload text): why a custom redaction pattern could not be applied. */
  readonly notes: readonly string[];
  /**
   * Set when a tenant's custom redaction pattern could not be applied to the payload (a pattern that
   * is unusable, too slow, too greedy, or starved by the request's time budget). The payload is then
   * only partly redacted, so it is refused and no redacted content leaves the pipeline: the preview
   * says so as an error issue and a create answers with this error (422).
   */
  readonly incomplete: RedactionIncompleteError | null;
}
