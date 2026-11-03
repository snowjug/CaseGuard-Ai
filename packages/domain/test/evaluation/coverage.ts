import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadDataset,
  loadVocabulary,
  EVALUATION_ROOT,
  type Dataset,
  type VocabularyData,
} from './dataset';
import { acceptedFor } from './labels';
import { CASE_CATEGORIES, NEGATION_REASONS, SPLITS, type CaseCategory, type Split } from './schema';

/**
 * What the corpus covers and what it still lacks. It reads accepted labels only (a case whose labels are excluded or
 * unadjudicated counts as a case but contributes no label), and it never runs the engine.
 */

export const NAMED_CAUSES = [
  'hyp.dns-resolution',
  'hyp.proxy-egress',
  'hyp.conditional-access',
  'hyp.token-session',
  'hyp.device-state',
  'hyp.service-incident',
] as const;

/** The minima of the brief. `noisy` counts independent noisy cases; reordered copies are extra and counted apart. */
export const MINIMA = {
  perSplit: {
    dev: {
      independent: 41,
      paraphrase: 14,
      noisy: 7,
      'negative-control': 6,
      negation: 4,
      contradiction: 4,
      unsupported: 2,
    },
    validation: {
      independent: 16,
      paraphrase: 4,
      noisy: 3,
      'negative-control': 4,
      negation: 2,
      contradiction: 2,
      unsupported: 1,
    },
    test: {
      independent: 24,
      paraphrase: 7,
      noisy: 5,
      'negative-control': 5,
      negation: 4,
      contradiction: 4,
      unsupported: 2,
    },
  },
  overall: {
    independent: 80,
    paraphrase: 25,
    noisy: 15,
    'negative-control': 15,
    negation: 10,
    contradiction: 10,
    unsupported: 5,
  },
  presentSignals: { overall: 300, devAndValidation: 200, test: 100 },
  /** Over all splits; dev and validation together must reach at least half of each. */
  casesPerCause: 4,
  casesPerSignalPresent: 6,
  casesPerSignalAbsent: 2,
  casesPerActionLabelled: 4,
  standardEvents: { min: 5, max: 16 },
  longEvents: { min: 25, max: 40, devAndValidation: 3 },
} as const;

type PerSplit = Record<Split, number>;
const zeroSplits = (): PerSplit => ({ dev: 0, validation: 0, test: 0 });

export interface SplitCounts {
  independent: number;
  /** Reordered copies: checked for invariance, not pooled. */
  reordered: number;
  categories: Record<CaseCategory, number>;
  /** Labelled present signal occurrences (event, signal) in the independent cases. */
  presentSignals: number;
  absentWithReason: number;
  /** Cases by length: 5 to 16 events, 25 to 40, and anything else. */
  standardLength: number;
  longLength: number;
  otherLength: readonly string[];
}

export interface IdCoverage {
  /** The number of independent cases that label it present / absent-with-reason, by split. */
  present: PerSplit;
  absent: PerSplit;
}

export interface Coverage {
  splits: Record<Split, SplitCounts>;
  causes: Record<string, PerSplit>;
  signals: Record<string, IdCoverage>;
  actions: Record<string, IdCoverage>;
  /** Independent cases by how their labels are accepted. */
  statuses: Record<string, number>;
}

const emptySplit = (): SplitCounts => ({
  independent: 0,
  reordered: 0,
  categories: Object.fromEntries(CASE_CATEGORIES.map((category) => [category, 0])) as Record<
    CaseCategory,
    number
  >,
  presentSignals: 0,
  absentWithReason: 0,
  standardLength: 0,
  longLength: 0,
  otherLength: [],
});

export function computeCoverage(dataset: Dataset, vocabulary: VocabularyData): Coverage {
  const splits: Record<Split, SplitCounts> = {
    dev: emptySplit(),
    validation: emptySplit(),
    test: emptySplit(),
  };
  const causes: Record<string, PerSplit> = Object.fromEntries(
    NAMED_CAUSES.map((id) => [id, zeroSplits()]),
  );
  const signals: Record<string, IdCoverage> = Object.fromEntries(
    vocabulary.signals.map((signal) => [
      signal.id,
      { present: zeroSplits(), absent: zeroSplits() },
    ]),
  );
  const actions: Record<string, IdCoverage> = Object.fromEntries(
    vocabulary.actions.map((action) => [
      action.id,
      { present: zeroSplits(), absent: zeroSplits() },
    ]),
  );
  const statuses: Record<string, number> = {};

  for (const loaded of dataset.cases) {
    const counts = splits[loaded.case.split];
    const split = loaded.case.split;
    if (loaded.case.derivedFrom !== null) {
      counts.reordered += 1;
      continue;
    }
    counts.independent += 1;
    for (const category of loaded.case.categories) counts.categories[category] += 1;
    const events = loaded.case.events.length;
    if (events >= MINIMA.standardEvents.min && events <= MINIMA.standardEvents.max)
      counts.standardLength += 1;
    else if (events >= MINIMA.longEvents.min && events <= MINIMA.longEvents.max)
      counts.longLength += 1;
    else counts.otherLength = [...counts.otherLength, `${loaded.case.id} (${events})`];

    const accepted = acceptedFor(dataset, loaded);
    statuses[accepted ? accepted.status : 'unlabelled'] =
      (statuses[accepted ? accepted.status : 'unlabelled'] ?? 0) + 1;
    const labels = accepted?.labels;
    if (!labels) continue;
    counts.presentSignals += labels.signals.length;
    for (const id of new Set(labels.signals.map((label) => label.id))) {
      const entry = signals[id];
      if (entry) entry.present[split] += 1;
    }
    for (const id of new Set((labels.actions ?? []).map((label) => label.id))) {
      const entry = actions[id];
      if (entry) entry.present[split] += 1;
    }
    const withReason = (labels.absent ?? []).filter((label) => NEGATION_REASONS.has(label.reason));
    counts.absentWithReason += withReason.length;
    for (const id of new Set(withReason.map((label) => label.id))) {
      const entry = signals[id] ?? actions[id];
      if (entry) entry.absent[split] += 1;
    }
    for (const cause of new Set(labels.causes ?? [])) {
      const entry = causes[cause];
      if (entry) entry[split] += 1;
    }
  }
  return { splits, causes, signals, actions, statuses };
}

// ---------------------------------------------------------------- minima

export interface Row {
  readonly requirement: string;
  readonly have: number;
  readonly need: number;
}

const sum = (values: PerSplit, among: readonly Split[]): number =>
  among.reduce((total, split) => total + values[split], 0);
const VISIBLE: readonly Split[] = ['dev', 'validation'];

export interface Minima {
  readonly dev: readonly Row[];
  readonly validation: readonly Row[];
  /** What the three splits together must reach (reordered copies excluded). */
  readonly overall: readonly Row[];
  /** What dev and validation must reach on their own for each id: half of each overall minimum. */
  readonly visibleHalf: readonly Row[];
  /** What the test split still lacks, given what dev and validation hold. */
  readonly testNeeds: readonly Row[];
}

const FLOOR_HALF = (n: number): number => Math.ceil(n / 2);

export function checkMinima(coverage: Coverage): Minima {
  const { splits } = coverage;
  const total = (pick: (counts: SplitCounts) => number): number =>
    SPLITS.reduce((sumOf, split) => sumOf + pick(splits[split]), 0);
  const rowsFor = (split: Split): Row[] =>
    (Object.keys(MINIMA.perSplit[split]) as (keyof (typeof MINIMA.perSplit)[Split])[]).map(
      (key) => ({
        requirement:
          key === 'independent'
            ? 'independent cases'
            : key === 'noisy'
              ? 'noisy cases (independent)'
              : `${key} cases`,
        have: key === 'independent' ? splits[split].independent : splits[split].categories[key],
        need: MINIMA.perSplit[split][key],
      }),
    );
  const overall: Row[] = [
    ...(Object.keys(MINIMA.overall) as (keyof typeof MINIMA.overall)[]).map((key) => ({
      requirement:
        key === 'independent'
          ? 'independent cases'
          : key === 'noisy'
            ? 'noisy cases (independent)'
            : `${key} cases`,
      have: total((counts) =>
        key === 'independent' ? counts.independent : counts.categories[key],
      ),
      need: MINIMA.overall[key],
    })),
    {
      requirement: 'labelled present signal occurrences',
      have: total((counts) => counts.presentSignals),
      need: MINIMA.presentSignals.overall,
    },
    ...NAMED_CAUSES.map((id) => ({
      requirement: `cause ${id}`,
      have: sum(coverage.causes[id] ?? zeroSplits(), SPLITS),
      need: MINIMA.casesPerCause,
    })),
    ...Object.entries(coverage.signals).flatMap(([id, entry]) => [
      {
        requirement: `${id} present`,
        have: sum(entry.present, SPLITS),
        need: MINIMA.casesPerSignalPresent,
      },
      {
        requirement: `${id} absent with a reason`,
        have: sum(entry.absent, SPLITS),
        need: MINIMA.casesPerSignalAbsent,
      },
    ]),
    ...Object.entries(coverage.actions).map(([id, entry]) => ({
      requirement: `${id} labelled`,
      have: sum(entry.present, SPLITS),
      need: MINIMA.casesPerActionLabelled,
    })),
  ];
  const visibleSignals = splits.dev.presentSignals + splits.validation.presentSignals;
  const visibleHalf: Row[] = [
    {
      requirement: 'labelled present signal occurrences (dev + validation)',
      have: visibleSignals,
      need: MINIMA.presentSignals.devAndValidation,
    },
    {
      requirement: 'long cases of 25 to 40 events (dev + validation)',
      have: splits.dev.longLength + splits.validation.longLength,
      need: MINIMA.longEvents.devAndValidation,
    },
    ...NAMED_CAUSES.map((id) => ({
      requirement: `cause ${id}`,
      have: sum(coverage.causes[id] ?? zeroSplits(), VISIBLE),
      need: FLOOR_HALF(MINIMA.casesPerCause),
    })),
    ...Object.entries(coverage.signals).flatMap(([id, entry]) => [
      {
        requirement: `${id} present`,
        have: sum(entry.present, VISIBLE),
        need: FLOOR_HALF(MINIMA.casesPerSignalPresent),
      },
      {
        requirement: `${id} absent with a reason`,
        have: sum(entry.absent, VISIBLE),
        need: FLOOR_HALF(MINIMA.casesPerSignalAbsent),
      },
    ]),
    ...Object.entries(coverage.actions).map(([id, entry]) => ({
      requirement: `${id} labelled`,
      have: sum(entry.present, VISIBLE),
      need: FLOOR_HALF(MINIMA.casesPerActionLabelled),
    })),
  ];
  // What test must hold: its own minimum, or what the overall minimum leaves after dev and validation, whichever is more.
  const testNeeds: Row[] = [
    ...(Object.keys(MINIMA.perSplit.test) as (keyof (typeof MINIMA.perSplit)['test'])[]).map(
      (key) => {
        const have = key === 'independent' ? splits.test.independent : splits.test.categories[key];
        const visible = VISIBLE.reduce(
          (n, split) =>
            n + (key === 'independent' ? splits[split].independent : splits[split].categories[key]),
          0,
        );
        return {
          requirement:
            key === 'independent'
              ? 'independent cases'
              : key === 'noisy'
                ? 'noisy cases (independent)'
                : `${key} cases`,
          have,
          need: Math.max(MINIMA.perSplit.test[key], MINIMA.overall[key] - visible),
        };
      },
    ),
    {
      requirement: 'labelled present signal occurrences',
      have: splits.test.presentSignals,
      need: Math.max(MINIMA.presentSignals.test, MINIMA.presentSignals.overall - visibleSignals),
    },
    ...NAMED_CAUSES.map((id) => ({
      requirement: `cause ${id}`,
      have: coverage.causes[id]?.test ?? 0,
      need: Math.max(0, MINIMA.casesPerCause - sum(coverage.causes[id] ?? zeroSplits(), VISIBLE)),
    })),
    ...Object.entries(coverage.signals).flatMap(([id, entry]) => [
      {
        requirement: `${id} present`,
        have: entry.present.test,
        need: Math.max(0, MINIMA.casesPerSignalPresent - sum(entry.present, VISIBLE)),
      },
      {
        requirement: `${id} absent with a reason`,
        have: entry.absent.test,
        need: Math.max(0, MINIMA.casesPerSignalAbsent - sum(entry.absent, VISIBLE)),
      },
    ]),
    ...Object.entries(coverage.actions).map(([id, entry]) => ({
      requirement: `${id} labelled`,
      have: entry.present.test,
      need: Math.max(0, MINIMA.casesPerActionLabelled - sum(entry.present, VISIBLE)),
    })),
  ];
  return {
    dev: rowsFor('dev'),
    validation: rowsFor('validation'),
    overall,
    visibleHalf,
    testNeeds,
  };
}

export const unmet = (rows: readonly Row[]): Row[] => rows.filter((row) => row.have < row.need);

// ---------------------------------------------------------------- report

const table = (headers: readonly string[], rows: readonly (readonly string[])[]): string[] => [
  `| ${headers.join(' | ')} |`,
  `| ${headers.map((_, index) => (index === 0 ? '---' : '---:')).join(' | ')} |`,
  ...rows.map((row) => `| ${row.join(' | ')} |`),
];

const mark = (row: Row): string =>
  row.have >= row.need ? 'met' : `short by ${row.need - row.have}`;

/** `showSplits` limits the per-split tables: the test author is shown only the test split. */
export function renderCoverage(
  coverage: Coverage,
  minima: Minima,
  options: { readonly showSplits: readonly Split[]; readonly testNeedsOnly: boolean },
): string {
  const out: string[] = ['# Corpus coverage', ''];
  const show = options.showSplits;
  out.push(
    ...table(
      ['', ...show],
      [
        ['independent cases', ...show.map((split) => String(coverage.splits[split].independent))],
        [
          'reordered copies (extra)',
          ...show.map((split) => String(coverage.splits[split].reordered)),
        ],
        ...CASE_CATEGORIES.filter((category) => category !== 'reordered').map((category) => [
          `category: ${category}`,
          ...show.map((split) => String(coverage.splits[split].categories[category])),
        ]),
        [
          'labelled present signal occurrences',
          ...show.map((split) => String(coverage.splits[split].presentSignals)),
        ],
        [
          'labelled absences with a reason',
          ...show.map((split) => String(coverage.splits[split].absentWithReason)),
        ],
        [
          'cases of 5 to 16 events',
          ...show.map((split) => String(coverage.splits[split].standardLength)),
        ],
        [
          'cases of 25 to 40 events',
          ...show.map((split) => String(coverage.splits[split].longLength)),
        ],
        [
          'cases of any other length',
          ...show.map((split) => String(coverage.splits[split].otherLength.length)),
        ],
      ],
    ),
    '',
  );
  if (!options.testNeedsOnly) {
    for (const split of ['dev', 'validation'] as const) {
      if (!show.includes(split)) continue;
      out.push(
        `## Minimum for the ${split} split`,
        '',
        ...table(
          ['Requirement', 'Have', 'Need', ''],
          minima[split].map((row) => [
            row.requirement,
            String(row.have),
            String(row.need),
            mark(row),
          ]),
        ),
        '',
      );
    }
    out.push(
      '## Minimum over all splits',
      '',
      ...table(
        ['Requirement', 'Have', 'Need', ''],
        minima.overall
          .filter(
            (row) =>
              !/^(sig|act)\./.test(row.requirement.split(' ')[0] ?? '') || row.have < row.need,
          )
          .map((row) => [row.requirement, String(row.have), String(row.need), mark(row)]),
      ),
      '',
      'Per-signal and per-action rows are listed only while they are short.',
      '',
      '## Dev and validation on their own (half of each per-id minimum)',
      '',
      ...table(
        ['Requirement', 'Have', 'Need', ''],
        minima.visibleHalf
          .filter(
            (row) =>
              row.have < row.need || !/^(sig|act)\./.test(row.requirement.split(' ')[0] ?? ''),
          )
          .map((row) => [row.requirement, String(row.have), String(row.need), mark(row)]),
      ),
      '',
    );
  }
  out.push(
    '## What the test split still lacks',
    '',
    'Counts are of independent cases. A row appears only while the test split is short of it.',
    '',
    ...table(
      ['Requirement', 'Have in test', 'Needs', 'Short by'],
      unmet(minima.testNeeds).map((row) => [
        row.requirement,
        String(row.have),
        String(row.need),
        String(row.need - row.have),
      ]),
    ),
    '',
  );
  return out.join('\n');
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  // `--for-test` shows the test split only (and what it lacks); it reads the other splits' labels only as counts.
  const forTest = process.argv.includes('--for-test');
  const dataset = loadDataset({ root: join(EVALUATION_ROOT) });
  const coverage = computeCoverage(dataset, loadVocabulary(EVALUATION_ROOT));
  process.stdout.write(
    `${renderCoverage(coverage, checkMinima(coverage), { showSplits: forTest ? ['test'] : [...SPLITS], testNeedsOnly: forTest })}\n`,
  );
}
