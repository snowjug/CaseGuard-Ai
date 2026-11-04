import { PROPOSAL_CODES } from '../../src/reasoning/types';
import {
  MUTATIONS,
  POLICY_CASES,
  SEMANTIC_ERRORS,
  byCategory,
  byTag,
  runMutation,
  runPolicyCase,
  runSemantic,
  type CategoryRow,
  type MutationResult,
  type PolicyResult,
  type SemanticResult,
} from './planted-errors';

export interface CorpusRun {
  mutations: MutationResult[];
  categories: CategoryRow[];
  families: CategoryRow[];
  policy: PolicyResult[];
  semantic: SemanticResult[];
}

export function runCorpus(): CorpusRun {
  const mutations = MUTATIONS.map(runMutation);
  return {
    mutations,
    categories: byCategory(mutations),
    families: byTag(mutations),
    policy: POLICY_CASES.map(runPolicyCase),
    semantic: SEMANTIC_ERRORS.map(runSemantic),
  };
}

const percent = (caught: number, planted: number): string =>
  planted === 0 ? 'n/a' : `${Math.round((caught / planted) * 1000) / 10}%`;

const table = (header: string[], rows: string[][]): string =>
  [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');

const rowsOf = (rows: readonly CategoryRow[]): string[][] => [
  ...rows.map((r) => [
    `\`${r.category}\``,
    String(r.planted),
    String(r.caught),
    percent(r.caught, r.planted),
    r.missed.join(', ') || '-',
  ]),
  [
    '**all**',
    String(rows.reduce((n, r) => n + r.planted, 0)),
    String(rows.reduce((n, r) => n + r.caught, 0)),
    percent(
      rows.reduce((n, r) => n + r.caught, 0),
      rows.reduce((n, r) => n + r.planted, 0),
    ),
    '',
  ],
];

/** The corpus result as Markdown. Printed by `eval:planted`; the tests assert on the same numbers. Nothing is written to disk. */
export function renderReport(run: CorpusRun): string {
  const planted = run.mutations.length;
  const caught = run.mutations.filter((m) => m.caught).length;
  const missed = run.mutations.filter((m) => !m.caught);
  const semanticPassed = run.semantic.filter((s) => s.passed).length;
  return [
    '# Planted-error evaluation of the grounding rules',
    '',
    `A grounded reply over the synthetic Case One, reviewed at event e15, with ${planted} planted errors (${caught} caught). Every figure below is a measurement of deterministic code; no model was called.`,
    '',
    '## Mechanical errors, by rule that must catch them',
    '',
    table(
      ['Rule', 'Planted', 'Caught', 'Catch rate', 'Missed'],
      rowsOf(run.categories.filter((c) => c.planted > 0)),
    ),
    '',
    `Rules with no planted error: ${
      run.categories
        .filter((c) => c.planted === 0)
        .map((c) => `\`${c.category}\``)
        .join(', ') || 'none'
    }.`,
    '',
    '## Mechanical errors, by family named in the brief',
    '',
    table(['Family', 'Planted', 'Caught', 'Catch rate', 'Missed'], rowsOf(run.families)),
    '',
    missed.length === 0
      ? 'Every planted mechanical error was caught.'
      : `Missed: ${missed.map((m) => m.mutation.id).join(', ')}.`,
    '',
    '## What the hybrid policy makes of grounded findings',
    '',
    table(
      ['Case', 'Expected status', 'Actual status', 'Result'],
      run.policy.map((p) => [
        p.case.description,
        p.case.expected,
        p.actual ?? 'none',
        p.actual === p.case.expected ? 'as expected' : 'DIFFERENT',
      ]),
    ),
    '',
    '## Semantic errors: well-formed, grounded, and wrong',
    '',
    `${semanticPassed} of ${run.semantic.length} passed every mechanical rule. They are meant to: the rules check form and grounding, not whether a statement is true to the record. A reviewer, or a critic measured against a real model, has to see them.`,
    '',
    table(
      ['Error', 'Passed the rules', 'Why it is wrong'],
      run.semantic.map((s) => [
        s.error.description,
        s.passed ? 'yes (not caught, by design)' : 'no',
        s.error.why,
      ]),
    ),
    '',
    '## Not run',
    '',
    '- A real model: NOT RUN. Nothing here says how often a real model makes any of these errors, or how it answers when the rules drop a proposal.',
    '- The critic: NOT RUN against a real model. The scripted critic replays a stated script, so its results measure nothing about a model; its only use is to test the code around it.',
    `- Rules: ${PROPOSAL_CODES.length} codes (${PROPOSAL_CODES.join(', ')}).`,
    '',
  ].join('\n');
}
