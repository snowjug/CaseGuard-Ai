import {
  IngestParseError,
  parseCaseBundleJson,
  parseCsvEvents,
  parsePastedTranscript,
  validateCaseBundleValue,
  type IngestDraftOptions,
  type IngestParseResult,
} from '@caseguard/domain';
import type { SourceKind, ValidationIssue } from '@caseguard/schemas';
import { sha256Hex } from '@caseguard/security';
import { NotFoundError, ValidationFailedError } from '../../errors';
import { findSample } from '../../samples';
import type { IngestSource } from '../ports';
import { syntheticLabelNote } from './policy';
import type { PipelineEnv } from './types';
import { prepareUpload, type PreparedUpload } from './uploads';

/** A payload read and parsed, before redaction, screening or any policy decision. */
export interface ResolvedInput {
  readonly parse: IngestParseResult;
  readonly sourceKind: SourceKind;
  /** Size of what was received, in bytes. */
  readonly sizeBytes: number;
  /** SHA-256 of what was received; identifies a payload that did not parse. */
  readonly receivedHash: string;
  readonly fileName: string | null;
  /**
   * The payload carries no synthetic label of its own (pasted text, CSV, plain text), so the parser
   * took the tenant's. The preview says so in a note; the policy has nothing further to add.
   */
  readonly labelDerived: boolean;
  /**
   * The workload the person chose for a JSON bundle file, which states its own and so cannot take another.
   * Null everywhere else: the parsers already used a choice for pasted text, CSV and plain text.
   */
  readonly chosenWorkload: string | null;
  /** Remarks for the preview (derived labels, what the scanner did). */
  readonly notes: ValidationIssue[];
}

const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

/** `JSON.stringify` of request data cannot fail, but this also serves in-process callers. */
function serialize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function draftOptions(
  env: PipelineEnv,
  extra: { title?: string | undefined; workload?: string | undefined } = {},
): IngestDraftOptions {
  const workload = extra.workload?.trim();
  return {
    synthetic: env.tenantSynthetic,
    now: env.now,
    ...(extra.title !== undefined ? { title: extra.title } : {}),
    ...(workload !== undefined && workload.length > 0 ? { workload } : {}),
  };
}

/** Invalid parser options are a defect of the caller, reported as a 422 instead of a crash. */
function guarded(run: () => IngestParseResult): IngestParseResult {
  try {
    return run();
  } catch (error) {
    if (error instanceof IngestParseError) {
      throw new ValidationFailedError(`The ingestion options are not valid: ${error.message}`);
    }
    throw error;
  }
}

function parseUpload(
  upload: PreparedUpload,
  env: PipelineEnv,
  workload: string | undefined,
): IngestParseResult {
  switch (upload.kind) {
    case 'json':
      return parseCaseBundleJson(upload.text);
    case 'csv':
      return guarded(() => parseCsvEvents(upload.text, draftOptions(env, { workload })));
    case 'text':
    case 'markdown':
      return guarded(() => parsePastedTranscript(upload.text, draftOptions(env, { workload })));
  }
}

/**
 * Turns any source (built-in sample, pasted text, JSON body, uploaded file) into a parse result.
 * Transport-level problems with an upload throw (413, 415, 422); everything the parsers can explain
 * comes back as a failed result with field-level issues.
 */
export async function resolveInput(source: IngestSource, env: PipelineEnv): Promise<ResolvedInput> {
  switch (source.type) {
    case 'sample': {
      const sample = findSample(source.sampleId);
      if (sample === null) throw new NotFoundError('Sample', source.sampleId);
      return {
        parse: parseCaseBundleJson(sample.json),
        sourceKind: 'builtin_sample',
        sizeBytes: byteLength(sample.json),
        receivedHash: sha256Hex(sample.json),
        fileName: sample.fileName,
        labelDerived: false,
        chosenWorkload: null,
        notes: [],
      };
    }
    case 'paste':
      return {
        parse: guarded(() =>
          parsePastedTranscript(
            source.text,
            draftOptions(env, { title: source.title, workload: source.workload }),
          ),
        ),
        sourceKind: 'pasted_text',
        sizeBytes: byteLength(source.text),
        receivedHash: sha256Hex(source.text),
        fileName: null,
        labelDerived: true,
        chosenWorkload: null,
        notes: [syntheticLabelNote(env.tenantSynthetic)],
      };
    case 'bundle': {
      const json = serialize(source.bundle);
      return {
        parse: validateCaseBundleValue(source.bundle),
        sourceKind: 'json_bundle',
        sizeBytes: byteLength(json),
        receivedHash: sha256Hex(json),
        fileName: null,
        labelDerived: false,
        chosenWorkload: null,
        notes: [],
      };
    }
    case 'file': {
      const upload = await prepareUpload(source.file, env);
      // A JSON bundle declares its own label; text and CSV inherit the tenant's.
      const labelDerived = upload.kind !== 'json';
      const chosen = source.workload?.trim();
      return {
        parse: parseUpload(upload, env, chosen !== undefined && chosen !== '' ? chosen : undefined),
        sourceKind: 'uploaded_file',
        sizeBytes: source.file.bytes.length,
        receivedHash: sha256Hex(source.file.bytes),
        fileName: upload.safeFileName,
        labelDerived,
        // Only a JSON bundle states a workload of its own, so only there can a choice contradict it.
        chosenWorkload: upload.kind === 'json' && chosen ? chosen : null,
        notes: [
          ...upload.notes,
          ...(labelDerived ? [syntheticLabelNote(env.tenantSynthetic)] : []),
        ],
      };
    }
  }
}
