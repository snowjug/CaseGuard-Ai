import { renderReport, runCorpus } from './planted-report';

/** `pnpm --filter @caseguard/ai run eval:planted`: prints the catch rate per category as Markdown. Writes nothing. */
const run = runCorpus();
process.stdout.write(`${renderReport(run)}\n`);
const missed = run.mutations.filter((m) => !m.caught);
if (missed.length > 0 || run.policy.some((p) => p.actual !== p.case.expected)) process.exitCode = 1;
