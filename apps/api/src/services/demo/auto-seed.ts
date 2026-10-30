import type { Container } from '../../container';
import { administratorContext } from './actors';
import { completedCount } from './derive';

/**
 * Start-up seeding (`DEMO_AUTO_SEED`, which configuration only allows in demo mode outside production):
 * the portfolio story is played as the seeded administrator of the synthetic tenant, after migrations
 * and before the server listens. Logs one line either way; a failure never stops the server, because a
 * half-seeded demo workspace is still a working one (a repeat run resumes where it stopped).
 */
export async function autoSeedDemo(infra: Container): Promise<void> {
  try {
    const ctx = await administratorContext(infra);
    const state = await infra.services.demo.seed(ctx, { profile: 'portfolio' });
    infra.logger.info(
      {
        event: 'demo.auto_seed',
        profile: 'portfolio',
        completedSteps: completedCount(state.steps),
        totalSteps: state.steps.length,
      },
      'demo data is ready (synthetic portfolio profile)',
    );
  } catch (error) {
    infra.logger.error(
      { err: error, event: 'demo.auto_seed_failed', profile: 'portfolio' },
      'the demo seed failed; the server starts without it',
    );
  }
}
