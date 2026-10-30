import type { DemoState } from '@caseguard/schemas';
import type { RequestContext } from '../../http/request-context';
import { readProviderStatus } from '../system';
import { deriveSteps } from './derive';
import { loadFacts } from './facts';
import { DEMO_DATASET_LABEL, demoNotices } from './notices';

/**
 * The guide as it stands: steps derived from the tenant's stored facts, when the seeder last ran, the
 * honest provider status and the notices. Read-only, so any role that can read cases may ask.
 */
export async function buildDemoState(ctx: RequestContext): Promise<DemoState> {
  const [facts, marker, provider] = await Promise.all([
    loadFacts(ctx),
    ctx.repos.demo.getSeedMarker(),
    readProviderStatus(ctx),
  ]);
  return {
    steps: deriveSteps(facts),
    seededAt: marker?.seededAt ?? null,
    datasetLabel: DEMO_DATASET_LABEL,
    provider: provider.kind,
    providerSimulated: provider.simulated,
    caseOneId: facts.caseOne?.id ?? null,
    caseTwoId: facts.caseTwo?.id ?? null,
    skillId: facts.skill?.id ?? null,
    notices: demoNotices(provider),
  };
}
