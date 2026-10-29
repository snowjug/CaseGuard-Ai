import type { HandlerMap } from '../http/route-binder';
import type { Infrastructure } from '../infrastructure';

/**
 * samples.list, ingestion.preview, ingestion.previewFile, cases.create, cases.createFromFile,
 * schemas.caseBundle, schemas.knowledgePack, examples.list, examples.get.
 * Owner: API ingestion/cases workstream. Replace the empty map with the handlers.
 */
export function ingestionRoutes(_infra: Infrastructure): HandlerMap {
  return {};
}
