import type { ServiceDeps } from '..';
import type { AnalysisPort } from '../ports';
import { unavailable } from '../unavailable';

/** Analysis pipeline service (owner: API analysis workstream). Replace this stub with the implementation. */
export function createAnalysisService(_deps: ServiceDeps): AnalysisPort {
  return unavailable<AnalysisPort>('AnalysisPort');
}
