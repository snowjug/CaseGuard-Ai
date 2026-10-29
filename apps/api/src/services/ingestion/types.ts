import type {
  CaseBundle,
  IngestionPreview,
  RedactionCategory,
  RedactionConfig,
  SourceKind,
} from '@caseguard/schemas';
import type { MalwareScanner } from '@caseguard/security';

/** Everything the pipeline needs from its caller; the pipeline itself never touches the database. */
export interface PipelineEnv {
  /** Injected instant (UTC ISO-8601): date of time-only stamps and reference of the future-date check. */
  readonly now: string;
  /** The tenant holds synthetic data only; pasted text and CSV inherit this label (they carry none). */
  readonly tenantSynthetic: boolean;
  readonly redaction: RedactionConfig;
  readonly uploadMaxBytes: number;
  readonly scanner: MalwareScanner;
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
  /** Operator-facing remarks of the redaction engine (never payload text). */
  readonly notes: readonly string[];
}
