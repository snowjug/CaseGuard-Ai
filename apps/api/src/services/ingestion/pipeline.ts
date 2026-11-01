import {
  buildDraftPreview,
  toValidationIssues,
  type IngestFailure,
  type IngestSuccess,
} from '@caseguard/domain';
import type { InjectionSummary, RedactionSummary, ValidationIssue } from '@caseguard/schemas';
import {
  RedactionIncompleteError,
  canonicalJson,
  createCustomPatternBudget,
  sha256Hex,
  type CustomPatternBudget,
} from '@caseguard/security';
import type { IngestSource } from '../ports';
import { resolveInput, type ResolvedInput } from './input';
import {
  REDACTION_PATH,
  describeIncomplete,
  errorIssue,
  orderIssues,
  sanitizeIssues,
} from './issues';
import { checkDataPolicy } from './policy';
import {
  credentialLikeIdentifiers,
  redactBundle,
  redactionOptionsFor,
  type BundleRedaction,
} from './redact';
import { screenBundle } from './screen';
import type { PipelineEnv, PipelineOutcome } from './types';
import { redactedBundleIssues, semanticIssues } from './validate';
import { checkWorkload } from './workload';

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
 * A preview that says "not ok" and shows nothing of the payload: no summary, no events, no counts.
 * The content hash is that of the input as received (never of anything that was redacted).
 */
function refusedOutcome(
  resolved: ResolvedInput,
  issues: readonly ValidationIssue[],
  extra: { notes?: readonly string[]; incomplete?: RedactionIncompleteError } = {},
): PipelineOutcome {
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
    notes: extra.notes ?? [],
    incomplete: extra.incomplete ?? null,
  };
}

function failedOutcome(
  resolved: ResolvedInput,
  parse: IngestFailure,
  env: PipelineEnv,
  budget: CustomPatternBudget,
): PipelineOutcome {
  const options = redactionOptionsFor(env.redaction, env.tenantSynthetic, budget);
  const sanitized = sanitizeIssues(
    [...toValidationIssues(parse.errors, parse.warnings), ...resolved.notes],
    options,
  );
  if (sanitized.incomplete === null) return refusedOutcome(resolved, sanitized.issues);
  // The texts of the issues were withheld; say why, so the list is not a riddle.
  return refusedOutcome(
    resolved,
    [...sanitized.issues, errorIssue(REDACTION_PATH, sanitized.incomplete.message)],
    { notes: describeIncomplete(sanitized.incomplete) },
  );
}

/** A tenant pattern could not be applied: the payload is refused and nothing redacted leaves here. */
function incompleteOutcome(
  resolved: ResolvedInput,
  error: RedactionIncompleteError,
): PipelineOutcome {
  return refusedOutcome(resolved, [errorIssue(REDACTION_PATH, error.message), ...resolved.notes], {
    notes: describeIncomplete(error),
    incomplete: error,
  });
}

async function succeededOutcome(
  resolved: ResolvedInput,
  parse: IngestSuccess,
  env: PipelineEnv,
  budget: CustomPatternBudget,
  pause: () => Promise<void>,
): Promise<PipelineOutcome> {
  const { bundle } = parse;
  const options = redactionOptionsFor(env.redaction, bundle.synthetic, budget);

  let redaction: BundleRedaction;
  try {
    redaction = await redactBundle(bundle, options, pause);
  } catch (error) {
    if (error instanceof RedactionIncompleteError) return incompleteOutcome(resolved, error);
    throw error;
  }
  await pause();
  const injection = await screenBundle(redaction.bundle, pause);
  await pause();

  const policy = checkDataPolicy({
    tenantSynthetic: env.tenantSynthetic,
    bundleSynthetic: bundle.synthetic,
    labelDerived: resolved.labelDerived,
  });
  const workload = checkWorkload(parse, resolved.sourceKind);
  const storedPayload = canonicalJson(redaction.bundle);
  const contentHash = sha256Hex(storedPayload);
  // Built from the redacted bundle, so no excerpt can carry a secret.
  const draft = buildDraftPreview(
    { ...parse, bundle: redaction.bundle, warnings: workload.warnings },
    { sourceKind: resolved.sourceKind, maxEvents: PREVIEW_EVENTS, excerptChars: EXCERPT_CHARS },
  );

  const found: ValidationIssue[] = [
    ...(policy === null ? [] : [policy]),
    ...workload.issues,
    ...credentialLikeIdentifiers(bundle, options),
    // Without a replacement the redacted bundle is the one the parser already validated.
    ...(redaction.summary.totalReplacements > 0 ? redactedBundleIssues(redaction.bundle) : []),
    ...semanticIssues(redaction.bundle, env.now),
    ...draft.issues,
    ...resolved.notes,
  ];
  const sanitized = sanitizeIssues(found, options);
  const issues = sanitized.issues;
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
    notes: sanitized.incomplete === null ? [] : describeIncomplete(sanitized.incomplete),
    incomplete: null,
  };
}

/**
 * The one pipeline behind preview and create: size and file checks, parse, policy, redaction, prompt
 * injection screening, semantic validation, content hash. It reads nothing from the database and
 * writes nothing anywhere, so a preview can never persist anything. Parse problems come back as a
 * failed preview with field-level issues; only unsafe or unsupported uploads throw.
 *
 * One custom-pattern time budget is created per call and shared by every redaction call of it (the
 * bundle, the issue texts). A tenant pattern that cannot be applied fails the payload closed: the
 * outcome carries `incomplete` and no redacted content (see `PipelineOutcome`).
 */
export async function runPipeline(
  source: IngestSource,
  env: PipelineEnv,
): Promise<PipelineOutcome> {
  const resolved = await resolveInput(source, env);
  const pause = resolved.sizeBytes >= LARGE_INPUT_BYTES ? yieldToEventLoop : noPause;
  await pause();
  const budget = env.customPatternBudget ?? createCustomPatternBudget();
  const { parse } = resolved;
  return parse.ok
    ? succeededOutcome(resolved, parse, env, budget, pause)
    : failedOutcome(resolved, parse, env, budget);
}
