import type {
  CaseDetail,
  ContradictionMeasures,
  InvarianceResult,
  LabelKindMeasures,
  MetricsResult,
} from './metrics';
import { EARLIEST_AGREEMENTS, LEADER_AGREEMENTS } from './metrics';
import type { PrecisionRecall, Proportion } from './stats';
import { ACTION_DIMENSION, EVAL_DIMENSIONS } from './vocabulary';

/**
 * Markdown for a run. It reads the same `MetricsResult` as the JSON artifact, so the report and the artifact cannot
 * disagree. Every proportion is shown with its Wilson 95% interval and the number of observations it rests on (`n`),
 * and is marked `too_few` when n is under 20.
 */

export interface RenderMeta {
  readonly title: string;
  readonly lines: readonly string[];
  readonly annotators: readonly { readonly id: string; readonly kind: string }[];
}

export interface RenderOptions {
  /** Per-signal and per-action tables. Left out for the locked split: aggregates only. */
  readonly perId: boolean;
  readonly details: readonly CaseDetail[] | null;
}

const pct = (value: number | null): string =>
  value === null ? 'n/a' : `${Math.round(value * 100)}%`;
const fixed = (value: number | null): string => (value === null ? 'n/a' : value.toFixed(3));

/** `76% [53–90%] n=17`, with ` too_few` when n is under 20. */
export function formatProportion(p: Proportion): string {
  if (p.value === null) return `n/a n=${p.n} too_few`;
  const interval =
    p.low !== null && p.high !== null
      ? ` [${Math.round(p.low * 100)}–${Math.round(p.high * 100)}%]`
      : '';
  return `${pct(p.value)}${interval} n=${p.n}${p.tooFew ? ' too_few' : ''}`;
}

const table = (headers: readonly string[], rows: readonly (readonly string[])[]): string[] => [
  `| ${headers.join(' | ')} |`,
  `| ${headers.map((_, index) => (index === 0 ? '---' : '---:')).join(' | ')} |`,
  ...rows.map((row) => `| ${row.join(' | ')} |`),
];

const prRow = (label: string, pr: PrecisionRecall): string[] => [
  label,
  String(pr.tp),
  String(pr.fp),
  String(pr.fn),
  formatProportion(pr.precision),
  formatProportion(pr.recall),
  pct(pr.f1),
];
const PR_HEADERS = [
  '',
  'Reported and labelled',
  'Reported, not labelled',
  'Labelled, not reported',
  'Precision',
  'Recall',
  'F1',
];

function kindSection(
  title: string,
  measures: LabelKindMeasures,
  perId: boolean,
  dimensions: readonly string[],
  idLabel: string,
): string[] {
  const out: string[] = [`## ${title}`, ''];
  if (measures.cases === 0) {
    out.push(
      'No case in this run is annotated for this kind of label, so nothing is measured.',
      '',
    );
    return out;
  }
  out.push(`${measures.cases} cases counted.`, '');
  out.push(...table(PR_HEADERS, [prRow('all', measures.overall)]), '');
  const categories = Object.entries(measures.byCategory);
  if (categories.length > 0) {
    out.push('By case category (a case counts in each of its categories):', '');
    out.push(
      ...table(
        PR_HEADERS,
        categories.map(([name, pr]) => prRow(name, pr)),
      ),
      '',
    );
  }
  const byDimension = dimensions
    .map((dimension) => [dimension, measures.byDimension[dimension]] as const)
    .filter((entry): entry is readonly [string, PrecisionRecall] => entry[1] !== undefined);
  if (byDimension.length > 0) {
    out.push('By dimension:', '');
    out.push(
      ...table(
        PR_HEADERS,
        byDimension.map(([name, pr]) => prRow(name, pr)),
      ),
      '',
    );
  }
  if (perId) {
    out.push(`By ${idLabel}:`, '');
    out.push(
      ...table(
        PR_HEADERS,
        Object.entries(measures.byId).map(([name, pr]) => prRow(name, pr)),
      ),
      '',
    );
  }
  return out;
}

const orNa = (p: Proportion | null): string => (p ? formatProportion(p) : 'n/a');

function contradictionLines(c: ContradictionMeasures): string[] {
  const out = ['## Contradictions', ''];
  if (c.status === 'no_labels') {
    out.push('No case in this run is annotated for conflicts.', '');
  } else if (c.status === 'not_available') {
    out.push(
      `not_available: the engine does not report conflicts yet. ${c.labelled} conflicts are labelled in ${c.cases} cases.`,
      '',
    );
  } else {
    out.push(
      ...table(
        ['Measure', 'Result'],
        [
          ['Labelled conflicts found (the same two events, either order)', orNa(c.foundPairs)],
          ['Class right among the found pairs', orNa(c.classAccuracy)],
          ['Subject equal among the found pairs (secondary)', orNa(c.subjectAgreement)],
          ['Reported conflicts that match a labelled one (precision)', orNa(c.precision)],
        ],
      ),
      '',
    );
  }
  return out;
}

export function renderMarkdown(
  metrics: MetricsResult,
  invariance: readonly InvarianceResult[],
  meta: RenderMeta,
  options: RenderOptions,
): string {
  const out: string[] = [`# ${meta.title}`, '', ...meta.lines.map((line) => `- ${line}`), ''];

  const { cases } = metrics;
  out.push('## Cases and labels', '');
  out.push(
    ...table(
      ['', 'Count'],
      [
        ['cases measured', String(cases.total)],
        ['labelled signal occurrences', String(cases.labelledSignals)],
        ['events', String(cases.events)],
        ...Object.entries(cases.byStatus).map(([status, count]) => [
          `labels: ${status}`,
          String(count),
        ]),
        ...Object.entries(cases.byCategory).map(([category, count]) => [
          `category: ${category}`,
          String(count),
        ]),
      ],
    ),
    '',
  );
  if (meta.annotators.length > 0) {
    const names = meta.annotators.map((entry) => `${entry.id} (${entry.kind})`).join(', ');
    const warning = meta.annotators.every((entry) => entry.kind === 'ai_draft')
      ? ' Every label is an AI draft: no human has judged it, so these figures measure agreement with an AI assistant, not accuracy.'
      : '';
    out.push(`Annotators: ${names}.${warning}`, '');
  }

  out.push(
    ...kindSection('Signals', metrics.signals, options.perId, [...EVAL_DIMENSIONS], 'signal'),
  );
  if (metrics.signals.cases > 0) {
    const causes = metrics.signals.missCauses;
    out.push(
      'Why a labelled signal was not reported, decided from how the detectors are defined and not from the wording:',
      '',
      ...table(
        ['Reason', 'Occurrences'],
        [
          ['only structured event data can show it', String(causes['structured-only'])],
          [
            "no text detector accepts the event's type or author role",
            String(causes['type-or-role-gate']),
          ],
          ['a text detector accepts the event; its pattern did not match', String(causes.wording)],
          ['not explained in this run', String(causes.unexplained)],
        ],
      ),
      '',
      `Recall over the occurrences a text detector could report: ${formatProportion(metrics.signals.reachableRecall)}`,
      '',
    );
  }

  out.push(...kindSection('Actions', metrics.actions, options.perId, [ACTION_DIMENSION], 'action'));

  const n = metrics.negation;
  out.push('## Negation and modality', '');
  if (n.cases === 0) {
    out.push('No case in this run is annotated for absences (words present, fact not stated).', '');
  } else {
    out.push(
      `${n.cases} cases counted. The engine is right on a decision when it fires exactly for what is present.`,
      '',
      ...table(
        ['Decisions', 'Right'],
        [
          ['all (present, or absent with a reason)', formatProportion(n.all)],
          ['absent: the engine stayed silent', formatProportion(n.onAbsent)],
          ['present: the engine fired', formatProportion(n.onPresent)],
          ...Object.entries(n.byReason).map(([reason, p]) => [
            `absent, ${reason}: silent`,
            formatProportion(p),
          ]),
        ],
      ),
      '',
    );
  }

  out.push(...contradictionLines(metrics.contradiction));

  out.push(
    '## Unsupported cases and negative controls',
    '',
    ...table(
      ['Measure', 'Result'],
      [
        [
          'unsupported workload refused by the engine',
          formatProportion(metrics.rejection.unsupported),
        ],
        [
          'negative controls with nothing to find: nothing reported and no decision point',
          formatProportion(metrics.rejection.negativeControls),
        ],
      ],
    ),
    '',
  );

  const f = metrics.forks;
  out.push('## Decision points', '');
  if (f.cases === 0) {
    out.push('No case in this run has labelled decision points.', '');
  } else {
    out.push(
      `${f.cases} cases counted: ${f.labelled} labelled forks, ${f.reported} reported by the engine.`,
      '',
      ...table(
        ['Measure', 'Result'],
        [
          ['precision (reported forks that match a label)', formatProportion(f.precision)],
          ['recall (labelled forks found)', formatProportion(f.recall)],
          ...Object.entries(f.recallByCategory).map(([category, p]) => [
            `recall, ${category}`,
            formatProportion(p),
          ]),
        ],
      ),
      '',
    );
  }
  const e = metrics.earliest;
  if (e.cases > 0) {
    out.push(
      'Earliest missed moment against the earliest decision point of the engine:',
      '',
      ...table(
        ['Agreement', 'Cases'],
        [
          ...EARLIEST_AGREEMENTS.map((name) => [name, String(e.counts[name])]),
          ['agree (exact, or both none)', formatProportion(e.agree)],
          ['agree within one event', formatProportion(e.withinOne)],
        ],
      ),
      '',
    );
  }

  const h = metrics.hypotheses;
  out.push('## Hypotheses and calibration', '');
  if (h.cases === 0) {
    out.push('No case in this run names a cause.', '');
  } else {
    out.push(
      `${h.cases} cases name a cause.`,
      '',
      ...table(
        ['Leading hypothesis', 'Cases'],
        LEADER_AGREEMENTS.map((name) => [name, String(h.leader[name])]),
      ),
      '',
      `The leading hypothesis is a labelled cause: ${formatProportion(h.leaderIsCause)}. Moved above its prior by evidence: ${formatProportion(h.leaderMovedByEvidence)}.`,
      '',
      `Calibration over ${h.calibration.n} (hypothesis, case) pairs: Brier ${fixed(h.calibration.brier)}, expected calibration error ${fixed(h.calibration.ece)}.`,
      '',
      ...table(
        ['Confidence bin', 'n', 'Mean confidence', 'Observed rate'],
        h.calibration.bins
          .filter((bin) => bin.n > 0)
          .map((bin) => [
            `${pct(bin.low)}–${pct(bin.high)}`,
            String(bin.n),
            pct(bin.meanPredicted),
            pct(bin.observedRate),
          ]),
      ),
      '',
    );
  }

  const c = metrics.citations;
  const r = metrics.recommendations;
  out.push(
    '## Citations and evidence links',
    '',
    ...table(
      ['Measure', 'Result'],
      [
        [
          `citations verified against the stored event text (${c.cases} cases)`,
          formatProportion(c.verified),
        ],
        ['citations that mismatch / are not checkable', `${c.mismatch} / ${c.notCheckable}`],
        [
          `recommendation-like outputs that carry evidence ids or are general guidance (${r.cases} cases)`,
          r.cases === 0 ? 'not computed in this run' : formatProportion(r.linked),
        ],
      ],
    ),
    '',
  );

  const cf = metrics.counterfactual;
  out.push('## Counterfactual direction', '');
  if (cf.status === 'not_run') {
    out.push('not run: pass `--counterfactual` to simulate the better path (slow).', '');
  } else {
    out.push(
      `Agreement between the label and the simulated better path of the engine at its earliest decision point: ${formatProportion(cf.agreement)}.`,
      '',
      ...table(
        ['Label \\ engine', 'better', 'none'],
        [
          ['better', String(cf.confusion.better.better), String(cf.confusion.better.none)],
          ['none', String(cf.confusion.none.better), String(cf.confusion.none.none)],
        ],
      ),
      '',
    );
  }
  if (metrics.quality.cases > 0) {
    out.push(
      '## Quality band',
      '',
      `Exact: ${formatProportion(metrics.quality.exact)}. Within one band: ${formatProportion(metrics.quality.withinOne)}.`,
      '',
    );
  }

  if (invariance.length > 0) {
    out.push(
      '## Order of events',
      '',
      ...table(
        ['Reordered copy', 'Source', 'Same analysis', 'Differs in'],
        invariance.map((entry) => [
          entry.caseId,
          entry.derivedFrom,
          entry.identical ? 'yes' : 'NO',
          entry.differences.join(', ') || '-',
        ]),
      ),
      '',
    );
  }

  if (options.details !== null) {
    out.push(
      '## Per case',
      '',
      'Per-case detail is for understanding a result. It must never be used to change a detector.',
      '',
      ...table(
        [
          'Case',
          'Labels',
          'Reported, not labelled',
          'Labelled, not reported',
          'Earliest',
          'Leader',
        ],
        options.details.map((d) => [
          d.id,
          d.status,
          d.signals?.fp.join(', ') || '-',
          d.signals?.fn.join(', ') || '-',
          d.earliest
            ? `${d.earliest.engine ?? '-'} vs ${d.earliest.label ?? '-'} (${d.earliest.agreement})`
            : '-',
          d.leader ? `${d.leader.key} ${pct(d.leader.confidence)} (${d.leader.agreement})` : '-',
        ]),
      ),
      '',
    );
  }

  out.push(
    '## Reading these figures',
    '',
    '- Wilson 95% intervals treat the occurrences as independent. They are not: occurrences cluster in cases, so the true uncertainty is larger.',
    '- A figure marked `too_few` rests on fewer than 20 observations and is a count, not an estimate.',
    '- Labels written by an AI assistant measure agreement with that assistant. Only a human annotator, or an adjudication, can make them a reference.',
    '- The corpus is synthetic text; nothing here says how the engine behaves on real support cases.',
    '',
  );
  return out.join('\n');
}
