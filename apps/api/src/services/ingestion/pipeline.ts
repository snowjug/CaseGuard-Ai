import {
  BundleValidationError,
  buildDraftPreview,
  normalizeBundle,
  toValidationIssues,
  type IngestFailure,
  type IngestSuccess,
} from '@caseguard/domain';
import type {
  CaseBundle,
  InjectionSummary,
  RedactionSummary,
  ValidationIssue,
} from '@caseguard/schemas';
import { canonicalJson, sha256Hex } from '@caseguard/security';
import type { IngestSource } from '../ports';
import { resolveInput, type ResolvedInput } from './input';
import { errorIssue, formatPath, orderIssues, sanitizeIssues } from './issues';
import { checkDataPolicy } from './policy';
import { credentialLikeIdentifiers, redactBundle, redactionOptionsFor } from './redact';
import { screenBundle } from './screen';
import type { PipelineEnv, PipelineOutcome } from './types';

/**
 * Inputs from this size on yield to the event loop between phases: parsing and redaction are
 * synchronous and CPU-bound (a 2 MB CSV takes about a second), and other requests must not starve.
 */
const LARGE_INPUT_BYTES = 100_000;
const PREVIEW_EVENTS = 25;
const EXCERPT_CHARS = 400;

const yieldToEventLoop = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));
const noPause = (): Promise<void> => Promise.resolve();

const emptyRedaction = (): RedactionSummary => ({
  applied: false,
  totalReplacements: 0,
  findings: [],
});
const emptyInjection = (): InjectionSummary => ({
  detected: false,
  highestSeverity: 'none',
  findings: [],
});

/**
 * `normalizeBundle` is what rejects replies that point at later events. Running it here (with
 * throwaway ids) makes a preview refuse exactly what ingestion would, with the same field paths.
 */
function semanticIssues(bundle: CaseBundle, now: string): ValidationIssue[] {
  try {
    normalizeBundle(bundle, {
      tenantId: 'preview',
      caseId: 'preview',
      sourceId: 'preview',
      createdBy: 'preview',
      now,
      sourceKind: 'pasted_text',
      storedPayload: '{}',
      redactionReplacements: 0,
    });
    return [];
  } catch (error) {
    if (error instanceof BundleValidationError) {
      return error.issues.map((issue) => errorIssue(formatPath(issue.path), issue.message));
    }
    throw error;
  }
}

function failedOutcome(
  resolved: ResolvedInput,
  parse: IngestFailure,
  env: PipelineEnv,
): PipelineOutcome {
  const options = redactionOptionsFor(env.redaction, env.tenantSynthetic);
  const issues = sanitizeIssues(
    [...toValidationIssues(parse.errors, parse.warnings), ...resolved.notes],
    options,
  );
  return {
    preview: {
      ok: false,
      sourceKind: resolved.sourceKind,
      contentHash: resolved.receivedHash,
      sizeBytes: resolved.sizeBytes,
      synthetic: false,
      issues: orderIssues(issues),
      redaction: emptyRedaction(),
      injection: emptyInjection(),
      summary: null,
      eventsPreview: [],
      alreadyIngestedCaseId: null,
    },
    prepared: null,
    notes: [],
  };
}

async function succeededOutcome(
  resolved: ResolvedInput,
  parse: IngestSuccess,
  env: PipelineEnv,
  pause: () => Promise<void>,
): Promise<PipelineOutcome> {
  const { bundle } = parse;
  const options = redactionOptionsFor(env.redaction, bundle.synthetic);

  const redaction = await redactBundle(bundle, options, pause);
  await pause();
  const injection = await screenBundle(redaction.bundle, pause);
  await pause();

  const policy = checkDataPolicy({
    tenantSynthetic: env.tenantSynthetic,
    bundleSynthetic: bundle.synthetic,
    labelDerived: resolved.labelDerived,
  });
  const storedPayload = canonicalJson(redaction.bundle);
  const contentHash = sha256Hex(storedPayload);
  // Built from the redacted bundle, so no excerpt can carry a secret.
  const draft = buildDraftPreview(
    { ...parse, bundle: redaction.bundle },
    { sourceKind: resolved.sourceKind, maxEvents: PREVIEW_EVENTS, excerptChars: EXCERPT_CHARS },
  );

  const found: ValidationIssue[] = [
    ...(policy === null ? [] : [policy]),
    ...credentialLikeIdentifiers(bundle, options),
    ...semanticIssues(redaction.bundle, env.now),
    ...draft.issues,
    ...resolved.notes,
  ];
  const issues = sanitizeIssues(found, options);
  const ok = issues.every((issue) => issue.severity !== 'error');

  return {
    preview: {
      ok,
      sourceKind: resolved.sourceKind,
      contentHash,
      sizeBytes: resolved.sizeBytes,
      synthetic: bundle.synthetic,
      issues: orderIssues(issues),
      redaction: redaction.summary,
      injection,
      summary: draft.summary,
      eventsPreview: draft.eventsPreview,
      alreadyIngestedCaseId: null,
    },
    prepared: ok
      ? {
          bundle: redaction.bundle,
          storedPayload,
          contentHash,
          sourceKind: resolved.sourceKind,
          fileName: resolved.fileName,
          redactionByEventId: redaction.byEventId,
        }
      : null,
    notes: redaction.notes,
  };
}

/**
 * The one pipeline behind preview and create: size and file checks, parse, policy, redaction, prompt
 * injection screening, semantic validation, content hash. It reads nothing from the database and
 * writes nothing anywhere, so a preview can never persist anything. Parse problems come back as a
 * failed preview with field-level issues; only unsafe or unsupported uploads throw.
 */
export async function runPipeline(
  source: IngestSource,
  env: PipelineEnv,
): Promise<PipelineOutcome> {
  const resolved = await resolveInput(source, env);
  const pause = resolved.sizeBytes >= LARGE_INPUT_BYTES ? yieldToEventLoop : noPause;
  await pause();
  const { parse } = resolved;
  return parse.ok
    ? succeededOutcome(resolved, parse, env, pause)
    : failedOutcome(resolved, parse, env);
}
