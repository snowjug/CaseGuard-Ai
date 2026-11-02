import {
  evaluateAll,
  forkSummary,
  leaderSummary,
  missSummary,
  rate,
  rateBySignal,
  reachableRecall,
  type Rate,
} from './evaluate';

/**
 * Prints the measures of the independent evaluation set as Markdown tables: `pnpm --filter @caseguard/domain run eval`.
 * It uses the same code as `evaluation.test.ts`, so the numbers in `docs/EVALUATION.md` can be reproduced.
 */
const pct = (value: number | null): string =>
  value === null ? 'n/a' : `${(value * 100).toFixed(0)}%`;
const row = (label: string, r: Rate): string =>
  `| ${label} | ${r.tp} | ${r.fp} | ${r.fn} | ${pct(r.precision)} | ${pct(r.recall)} |`;

const { results, scored } = evaluateAll();
const out: string[] = [];

out.push(
  '| Group | Reported and expected | Reported, not expected | Expected, not reported | Precision | Recall |',
);
out.push('| --- | ---: | ---: | ---: | ---: | ---: |');
for (const group of ['paraphrase', 'noisy', 'negative'] as const)
  out.push(row(group, rate(scored.filter((result) => result.group === group))));
out.push(row('all', rate(scored)));

const causes = missSummary(scored);
out.push('', '| Why an expected signal was not reported | Occurrences |', '| --- | ---: |');
out.push(
  `| Only structured event data can show it (free text cannot) | ${causes['structured-only']} |`,
);
out.push(
  `| No text detector accepts the event's type or author role | ${causes['type-or-role-gate']} |`,
);
out.push(`| A text detector accepts the event; its pattern did not match | ${causes.wording} |`);
out.push(
  '',
  `Recall over the occurrences a text detector could report: ${pct(reachableRecall(scored))}`,
);

out.push(
  '',
  '| Signal | Reported and expected | Reported, not expected | Expected, not reported | Precision | Recall |',
);
out.push('| --- | ---: | ---: | ---: | ---: | ---: |');
for (const [id, r] of rateBySignal(scored)) out.push(row(id, r));

const forks = forkSummary(scored);
out.push('', '| Earliest decision point | Cases |', '| --- | ---: |');
for (const [name, count] of Object.entries(forks)) out.push(`| ${name} | ${count} |`);

const leaders = leaderSummary(scored);
out.push('', '| Leading hypothesis | Cases |', '| --- | ---: |');
out.push(`| the story's cause, moved above its prior by evidence | ${leaders.right} |`);
out.push(
  `| the story's cause, but only because it is the favourite before evidence | ${leaders['right-by-prior']} |`,
);
out.push(`| "other" (no named cause) | ${leaders.other} |`);
out.push(`| a different named cause | ${leaders.wrong} |`);
out.push(`| not a sign-in failure (no cause expected) | ${leaders['n/a']} |`);

out.push(
  '',
  '| Case | Group | Leading hypothesis | Agreement | Story cause: rank, confidence (prior) |',
  '| --- | --- | --- | --- | --- |',
);
for (const r of results)
  out.push(
    `| ${r.id} | ${r.group} | ${r.leader} (${(r.leaderConfidence * 100).toFixed(0)}%) | ${r.leaderAgreement} | ${r.causeRank === null ? '-' : `${r.causeRank}, ${((r.causeConfidence ?? 0) * 100).toFixed(0)}% (${((r.causePrior ?? 0) * 100).toFixed(0)}%)`} |`,
  );

out.push(
  '',
  '| Case | Group | Forks | Earliest | Expected | Agreement | Reported, not expected | Expected, not reported |',
);
out.push('| --- | --- | ---: | --- | --- | --- | --- | --- |');
for (const r of results)
  out.push(
    `| ${r.id} | ${r.group} | ${r.forkCount} | ${r.earliestFork ?? '-'} | ${r.expectedFork ?? '-'} | ${r.forkAgreement} | ${r.falsePositives.join(', ') || '-'} | ${r.misses.map((item) => `${item} (${r.missCauses[item] ?? '?'})`).join(', ') || '-'} |`,
  );

process.stdout.write(`${out.join('\n')}\n`);
