import type { IngestResult, IngestionPreview, ValidationIssue } from '@caseguard/schemas';
import { createMalwareScanner } from '@caseguard/security';
import { UnsafeContentError, ValidationFailedError } from '../../errors';
import type { RequestContext } from '../../http/request-context';
import type { ServiceDeps } from '..';
import type { IngestInput, IngestSource, IngestionPort } from '../ports';
import { persistCase } from './persist';
import { runPipeline } from './pipeline';
import type { PipelineEnv, PipelineOutcome } from './types';

/** What the pipeline needs from the tenant's settings and the process configuration. */
async function loadEnv(ctx: RequestContext): Promise<PipelineEnv> {
  const [tenant, settings] = await Promise.all([
    ctx.repos.governance.getTenant(),
    ctx.repos.governance.getSettings(),
  ]);
  return {
    now: ctx.now().toISOString(),
    tenantSynthetic: tenant.synthetic,
    redaction: settings.redaction.value,
    uploadMaxBytes: ctx.config.http.uploadMaxBytes,
    scanner: createMalwareScanner(ctx.config.limits.malwareScanMode),
  };
}

async function runChecked(ctx: RequestContext, source: IngestSource): Promise<PipelineOutcome> {
  let outcome: PipelineOutcome;
  try {
    outcome = await runPipeline(source, await loadEnv(ctx));
  } catch (error) {
    // A refused upload is a security signal; record that it happened (never what it contained).
    if (error instanceof UnsafeContentError) {
      ctx.logger.warn(
        { event: 'ingest.unsafe_upload_refused', code: error.code, status: error.status },
        'an upload was refused as unsafe',
      );
    }
    throw error;
  }
  if (outcome.notes.length > 0) {
    ctx.logger.warn(
      { event: 'ingest.redaction_notes', notes: outcome.notes },
      'the redaction engine reported remarks',
    );
  }
  return outcome;
}

/** Validates, redacts and screens a payload; reports whether the same content is already stored. */
async function previewSource(ctx: RequestContext, source: IngestSource): Promise<IngestionPreview> {
  const outcome = await runChecked(ctx, source);
  const existing =
    outcome.prepared === null
      ? null
      : await ctx.repos.cases.findByContentHash(outcome.preview.contentHash);
  return { ...outcome.preview, alreadyIngestedCaseId: existing?.id ?? null };
}

/** A refused payload as a 422 whose `errors` are the field-level issues the preview would show. */
function refusal(issues: readonly ValidationIssue[]): ValidationFailedError {
  const errors = issues
    .filter((issue) => issue.severity === 'error')
    .map(({ path, message }) => ({ path, message }));
  return new ValidationFailedError(errors[0]?.message ?? 'The payload cannot be ingested', errors);
}

async function ingestSource(ctx: RequestContext, input: IngestInput): Promise<IngestResult> {
  const outcome = await runChecked(ctx, input.source);
  if (outcome.prepared === null) throw refusal(outcome.preview.issues);
  return persistCase(
    ctx,
    { prepared: outcome.prepared, preview: outcome.preview },
    { analyze: input.analyze !== false },
  );
}

/**
 * Case ingestion (FR-ING-01..08): one pipeline (`runPipeline`) feeds both the preview and the create,
 * so what a preview promises is what ingestion stores. Natural idempotency is the content hash, so
 * `IngestInput.idempotencyKey` needs no handling here; the HTTP layer replays by key on top of it.
 */
export function createIngestionService(_deps: ServiceDeps): IngestionPort {
  return { ingest: ingestSource, preview: previewSource };
}
