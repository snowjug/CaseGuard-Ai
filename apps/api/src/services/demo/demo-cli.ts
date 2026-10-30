import { ConfigError, loadConfig } from '@caseguard/config';
import { createInfrastructure, type Container } from '../../container';
import { AppError } from '../../errors';
import packageJson from '../../../package.json';
import type { DemoProfile } from '../ports';
import { administratorContext } from './actors';
import { completedCount } from './derive';

export type DemoCommand = 'seed' | 'reset';

type Parsed =
  | { readonly ok: true; readonly profile: DemoProfile }
  | { readonly ok: false; readonly message: string };

const PROFILES: readonly DemoProfile[] = ['base', 'portfolio'];

const USAGE: Readonly<Record<DemoCommand, string>> = {
  seed: 'Usage: pnpm demo:seed [-- --profile base|portfolio]   (default: portfolio)',
  reset: 'Usage: pnpm demo:reset',
};

/** `--profile base|portfolio` (or `--profile=base`) for the seed; nothing else is accepted. */
function parse(command: DemoCommand, argv: readonly string[]): Parsed {
  let profile: DemoProfile = 'portfolio';
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (command !== 'seed' || !(argument === '--profile' || argument.startsWith('--profile='))) {
      return { ok: false, message: USAGE[command] };
    }
    let value: string | undefined;
    if (argument.includes('=')) {
      value = argument.slice(argument.indexOf('=') + 1);
    } else {
      index += 1;
      value = argv[index];
    }
    const chosen = PROFILES.find((candidate) => candidate === value);
    if (chosen === undefined) return { ok: false, message: `Unknown profile. ${USAGE.seed}` };
    profile = chosen;
  }
  return { ok: true, profile };
}

/** Only an application error carries a message that is safe to print; anything else stays in the log. */
const messageOf = (error: unknown): string =>
  error instanceof AppError
    ? error.message
    : 'An unexpected error occurred; see the log output above.';

/**
 * The command line behind `pnpm demo:seed` and `pnpm demo:reset`, in direct mode: the configuration
 * comes from the environment, the infrastructure is created in this process (migrating the database
 * when configured to), and the work is done by the same `DemoService` the routes use, as the seeded
 * administrator of the synthetic tenant. Prints a short summary, never a connection string or a
 * secret, and returns the exit code (0 success, 1 failure, 2 usage).
 */
export async function runDemoCli(
  command: DemoCommand,
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const parsed = parse(command, argv);
  if (!parsed.ok) {
    console.error(parsed.message);
    return 2;
  }

  let infra: Container;
  try {
    infra = await createInfrastructure(loadConfig(env, { defaultVersion: packageJson.version }));
  } catch (error) {
    console.error(
      error instanceof ConfigError
        ? error.message
        : 'The demo tooling could not start: the infrastructure failed to open.',
    );
    return 1;
  }

  try {
    const ctx = await administratorContext(infra);
    const state =
      command === 'seed'
        ? await infra.services.demo.seed(ctx, { profile: parsed.profile })
        : await infra.services.demo.reset(ctx);
    const done = completedCount(state.steps);
    const label = command === 'seed' ? `Demo seeded (${parsed.profile})` : 'Demo data reset';
    console.log(`${label}: ${done} of ${state.steps.length} story steps complete.`);
    if (state.caseOneId !== null) console.log(`  Case One: ${state.caseOneId}`);
    if (state.caseTwoId !== null) console.log(`  Case Two: ${state.caseTwoId}`);
    if (state.skillId !== null) console.log(`  Skill:    ${state.skillId}`);
    console.log(
      `${state.datasetLabel}. Provider: ${state.provider}${state.providerSimulated ? ' (simulated)' : ''}.`,
    );
    return 0;
  } catch (error) {
    infra.logger.error(
      { err: error, event: 'demo.cli_failed', command },
      'the demo command failed',
    );
    console.error(`Demo ${command} failed: ${messageOf(error)}`);
    return 1;
  } finally {
    await infra.close();
  }
}
