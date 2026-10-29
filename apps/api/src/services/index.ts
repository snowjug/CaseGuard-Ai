import type { BaseInfrastructure } from '../infrastructure';
import { createAiService } from './ai';
import { createAnalysisService } from './analysis';
import { createCounterfactualService } from './counterfactuals';
import { createIngestionService } from './ingestion';
import { JobService } from './job-service';
import type { Services } from './ports';
import { createSkillsService } from './skills';

/** What a service needs to be built: process-wide infrastructure and a late-bound view of its peers. */
export interface ServiceDeps {
  readonly infra: BaseInfrastructure;
  /** Resolves the other services when called (not at construction), so services may depend on each other. */
  readonly services: () => Services;
}

/**
 * Builds every service. This is the one place where ports are bound to implementations. `overrides`
 * replaces individual services (tests inject fakes); peers resolve the final set, overrides included.
 */
export function createServices(
  infra: BaseInfrastructure,
  overrides: Partial<Services> = {},
): Services {
  // eslint-disable-next-line prefer-const -- assigned after the deps closure that reads it exists
  let services: Services;
  const deps: ServiceDeps = { infra, services: () => services };
  services = {
    jobs: new JobService(infra),
    ai: createAiService(infra),
    analysis: createAnalysisService(deps),
    counterfactuals: createCounterfactualService(deps),
    skills: createSkillsService(deps),
    ingestion: createIngestionService(deps),
    objects: infra.objects,
    ...overrides,
  };
  return services;
}

export type { Services } from './ports';
