import { checkFileName } from '@caseguard/security';
import { NotFoundError } from '../errors';
import { reply, type HandlerMap, type HttpReply } from '../http/route-binder';
import type { Infrastructure } from '../infrastructure';
import { findExample, listExampleInfos, listSampleInfos } from '../samples';
import { loadSchemaDocuments, type SchemaDocuments } from '../samples/schemas';

/** The documents never change while the process runs, so browsers may keep them for a few minutes. */
const STATIC_CACHE_CONTROL = 'private, max-age=300';

/** `Content-Disposition` of a download. `fileName` must already be safe (letters, digits, dot, dash, underscore). */
const attachment = (fileName: string): string => `attachment; filename="${fileName}"`;

/**
 * An example is a file (transcript, CSV or JSON text) that must reach the browser byte for byte.
 * The contract types the body as a JSON record, but Fastify skips the response serializer for a string
 * that has an explicit content type, so the text goes out untouched. The file name is sanitised on
 * the way out even though today's names are constants.
 */
function download(
  text: string,
  fileName: string,
  mediaType: string,
): HttpReply<Record<string, unknown>> {
  return reply(text as unknown as Record<string, unknown>, {
    'content-type': mediaType,
    'content-disposition': attachment(checkFileName(fileName).safeFileName),
    'cache-control': STATIC_CACHE_CONTROL,
  });
}

/**
 * samples.list, ingestion.preview, ingestion.previewFile, cases.create, cases.createFromFile,
 * schemas.caseBundle, schemas.knowledgePack, examples.list, examples.get.
 * The routes only map HTTP to the ingestion port and the embedded samples; the work is done in
 * `services/ingestion`.
 */
export function ingestionRoutes(_infra: Infrastructure): HandlerMap {
  let documents: SchemaDocuments | undefined;
  /** Computed on first use and kept for the life of the process. */
  const schemaDocuments = (): SchemaDocuments => (documents ??= loadSchemaDocuments());

  return {
    'samples.list': async () => ({ items: listSampleInfos() }),

    'ingestion.preview': ({ body, ctx }) => ctx.services.ingestion.preview(ctx, body.source),

    'ingestion.previewFile': ({ file, ctx }) =>
      ctx.services.ingestion.preview(ctx, { type: 'file', file }),

    'cases.create': ({ body, ctx, idempotencyKey }) =>
      ctx.services.ingestion.ingest(ctx, {
        source: body.source,
        analyze: body.options?.analyze ?? true,
        idempotencyKey,
      }),

    'cases.createFromFile': ({ file, ctx, idempotencyKey }) =>
      ctx.services.ingestion.ingest(ctx, { source: { type: 'file', file }, idempotencyKey }),

    'schemas.caseBundle': async () =>
      reply(schemaDocuments().caseBundle, {
        'content-disposition': attachment('case-bundle.schema.json'),
        'cache-control': STATIC_CACHE_CONTROL,
      }),

    'schemas.knowledgePack': async () =>
      reply(schemaDocuments().knowledgePack, {
        'content-disposition': attachment('knowledge-pack.schema.json'),
        'cache-control': STATIC_CACHE_CONTROL,
      }),

    'examples.list': async () => ({ items: listExampleInfos() }),

    'examples.get': async ({ params }) => {
      const example = findExample(params.exampleId);
      if (example === null) throw new NotFoundError('Example', params.exampleId);
      return download(example.text, example.fileName, example.mediaType);
    },
  };
}
