import type { ServiceDeps } from '..';
import type { IngestionPort } from '../ports';
import { unavailable } from '../unavailable';

/** Case ingestion service (owner: API ingestion/cases workstream). Replace this stub. */
export function createIngestionService(_deps: ServiceDeps): IngestionPort {
  return unavailable<IngestionPort>('IngestionPort');
}
