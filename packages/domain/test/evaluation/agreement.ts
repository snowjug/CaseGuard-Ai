import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVALUATION_ROOT, loadDataset, loadVocabulary, type VocabularyData } from './dataset';
import { latestRecords } from './labels';
import {
  SPLITS,
  type AnnotationRecord,
  type EvalEvent,
  type LabelKind,
  type Split,
} from './schema';
import {
  binaryAgreement,
  cohenKappa,
  type Agreement,
  type BinaryAgreement,
} from './stats';

/**
 * Agreement between two annotators of the same cases: Cohen's kappa per kind of label, and the disagreements to adjudicate.
 * Kappa is computed over the units a kind of label is decided on (an event and a signal, a pair of events, a case...), so a
 * kind with many empty units (most signals are absent on most events) has a high observed agreement and a lower kappa; the
 * positive agreement (2·both / (2·both + only A + only B)) says how well the two agree on what they did label.
 * An AI draft is never equivalent to a human annotator: two AI drafts agreeing says the same assistant is consistent, not
 * that the labels are right.
 */

export interface AgreementCase {
  readonly caseId: string;
  readonly events: readonly Pick<EvalEvent, 'key' | 'who'>[];
  readonly a: AnnotationRecord;
  readonly b: AnnotationRecord;
}

export interface KindAgreement {
  readonly kind: LabelKind | 'absentReason';
  /** What one unit of agreement is. */
  readonly unit: string;
  /** Cases that both annotators annotated for this kind. */
  readonly cases: number;
  readonly agreement: Agreement | BinaryAgreement;
}

export interface Disagreement {
  readonly caseId: string;
  readonly kind: LabelKind | 'absentReason';
  readonly item: string;
  readonly a: string;
  readonly b: string;
}

export interface AgreementReport {
  readonly annotatorA: string;
  readonly annotatorB: string;
  readonly cases: readonly string[];
  readonly kinds: readonly KindAgreement[];
  readonly disagreements: readonly Disagreement[];
}

const pairsOf = (keys: readonly string[]): [string, string][] => {
  const out: [string, string][] = [];
  keys.forEach((first, index) => {
    for (const second of keys.slice(index + 1)) out.push([first, second]);
  });
  return out;
};

class Binary {
  bothYes = 0;
  onlyA = 0;
  onlyB = 0;
  bothNo = 0;
  readonly differences: { item: string; a: string; b: string }[] = [];

  count(item: string, a: boolean, b: boolean, words: readonly [string, string]): void {
    if (a && b) this.bothYes += 1;
    else if (a) this.onlyA += 1;
    else if (b) this.onlyB += 1;
    else this.bothNo += 1;
    if (a !== b) this.differences.push({ item, a: a ? words[0] : words[1], b: b ? words[0] : words[1] });
  }
}

export function compareAnnotators(
  annotatorA: string,
  annotatorB: string,
  cases: readonly AgreementCase[],
  vocabulary: Pick<VocabularyData, 'signals' | 'actions' | 'hypotheses' | 'forkCategories'>,
): AgreementReport {
  const kinds: KindAgreement[] = [];
  const disagreements: Disagreement[] = [];
  const signalIds = vocabulary.signals.map((signal) => signal.id);
  const actionIds = vocabulary.actions.map((action) => action.id);
  const hypothesisIds = vocabulary.hypotheses.map((hypothesis) => hypothesis.id).filter((id) => id !== 'hyp.other');
  const forkCategories = vocabulary.forkCategories.map((category) => category.id);

  const addBinary = (kind: LabelKind | 'absentReason', unit: string, scoped: number, tally: Binary, caseId: (item: string) => string): void => {
    if (scoped === 0) return;
    kinds.push({ kind, unit, cases: scoped, agreement: binaryAgreement(tally) });
    for (const difference of tally.differences) disagreements.push({ caseId: caseId(difference.item), kind, ...difference, item: difference.item.slice(difference.item.indexOf('#') + 1) });
  };
  const addNominal = (kind: LabelKind, unit: string, pairs: readonly (readonly [string, string])[], where: readonly string[], items: readonly string[]): void => {
    if (pairs.length === 0) return;
    kinds.push({ kind, unit, cases: where.length, agreement: cohenKappa(pairs) });
    pairs.forEach(([a, b], index) => {
      if (a !== b) disagreements.push({ caseId: where[index] ?? '', kind, item: items[index] ?? '', a, b });
    });
  };

  // signals: every (event, signal) of every case is one decision.
  {
    const tally = new Binary();
    for (const entry of cases) {
      const inA = new Set(entry.a.signals.map((label) => `${label.event}|${label.id}`));
      const inB = new Set(entry.b.signals.map((label) => `${label.event}|${label.id}`));
      for (const event of entry.events) {
        for (const id of signalIds) {
          const key = `${event.key}|${id}`;
          tally.count(`${entry.caseId}#${key}`, inA.has(key), inB.has(key), ['present', 'absent']);
        }
      }
    }
    addBinary('signals', 'an event and a signal', cases.length, tally, (item) => item.slice(0, item.indexOf('#')));
  }

  // actions: the events an engineer wrote, and every action.
  {
    const scoped = cases.filter((entry) => entry.a.actions !== undefined && entry.b.actions !== undefined);
    const tally = new Binary();
    for (const entry of scoped) {
      const inA = new Set((entry.a.actions ?? []).map((label) => `${label.event}|${label.id}`));
      const inB = new Set((entry.b.actions ?? []).map((label) => `${label.event}|${label.id}`));
      for (const event of entry.events.filter((candidate) => candidate.who === 'engineer')) {
        for (const id of actionIds) {
          const key = `${event.key}|${id}`;
          tally.count(`${entry.caseId}#${key}`, inA.has(key), inB.has(key), ['present', 'absent']);
        }
      }
    }
    addBinary('actions', 'an engineer event and an action', scoped.length, tally, (item) => item.slice(0, item.indexOf('#')));
  }

  // absences: every (event, signal or action), then the reason where both marked one.
  {
    const scoped = cases.filter((entry) => entry.a.absent !== undefined && entry.b.absent !== undefined);
    const tally = new Binary();
    const reasons: [string, string][] = [];
    const reasonWhere: string[] = [];
    const reasonItems: string[] = [];
    for (const entry of scoped) {
      const absentA = new Map((entry.a.absent ?? []).map((label) => [`${label.event}|${label.id}`, label.reason]));
      const absentB = new Map((entry.b.absent ?? []).map((label) => [`${label.event}|${label.id}`, label.reason]));
      for (const event of entry.events) {
        for (const id of [...signalIds, ...actionIds]) {
          const key = `${event.key}|${id}`;
          tally.count(`${entry.caseId}#${key}`, absentA.has(key), absentB.has(key), ['absent', 'not marked']);
          const reasonA = absentA.get(key);
          const reasonB = absentB.get(key);
          if (reasonA !== undefined && reasonB !== undefined) {
            reasons.push([reasonA, reasonB]);
            reasonWhere.push(entry.caseId);
            reasonItems.push(key);
          }
        }
      }
    }
    addBinary('absent', 'an event and a signal or action', scoped.length, tally, (item) => item.slice(0, item.indexOf('#')));
    if (reasons.length > 0) {
      kinds.push({ kind: 'absentReason', unit: 'an absence both marked', cases: new Set(reasonWhere).size, agreement: cohenKappa(reasons) });
      reasons.forEach(([a, b], index) => {
        if (a !== b) disagreements.push({ caseId: reasonWhere[index] ?? '', kind: 'absentReason', item: reasonItems[index] ?? '', a, b });
      });
    }
  }

  // forks: the events an engineer wrote, and every category.
  {
    const scoped = cases.filter((entry) => entry.a.forks !== undefined && entry.b.forks !== undefined);
    const tally = new Binary();
    for (const entry of scoped) {
      const inA = new Set((entry.a.forks ?? []).map((label) => `${label.event}|${label.category}`));
      const inB = new Set((entry.b.forks ?? []).map((label) => `${label.event}|${label.category}`));
      for (const event of entry.events.filter((candidate) => candidate.who === 'engineer')) {
        for (const category of forkCategories) {
          const key = `${event.key}|${category}`;
          tally.count(`${entry.caseId}#${key}`, inA.has(key), inB.has(key), ['fork', 'no fork']);
        }
      }
    }
    addBinary('forks', 'an engineer event and a fork category', scoped.length, tally, (item) => item.slice(0, item.indexOf('#')));
  }

  // one value per case
  const nominal = (kind: LabelKind, unit: string, pick: (record: AnnotationRecord) => string | undefined): void => {
    const scoped = cases.filter((entry) => pick(entry.a) !== undefined && pick(entry.b) !== undefined);
    addNominal(
      kind,
      unit,
      scoped.map((entry) => [pick(entry.a) ?? '', pick(entry.b) ?? ''] as const),
      scoped.map((entry) => entry.caseId),
      scoped.map(() => 'the case'),
    );
  };
  nominal('earliestMissed', 'a case', (record) => (record.earliestMissed === undefined ? undefined : (record.earliestMissed ?? 'none')));
  nominal('counterfactualDirection', 'a case', (record) => record.counterfactualDirection);
  nominal('qualityBand', 'a case', (record) => (record.qualityBand === undefined ? undefined : (record.qualityBand ?? 'none')));

  // conflicts: every pair of events is a unit, valued by the class labelled on it (or none).
  {
    const scoped = cases.filter((entry) => entry.a.conflicts !== undefined && entry.b.conflicts !== undefined);
    const pairs: [string, string][] = [];
    const where: string[] = [];
    const items: string[] = [];
    for (const entry of scoped) {
      const classOf = (record: AnnotationRecord): Map<string, string> =>
        new Map((record.conflicts ?? []).map((label) => [[...label.events].sort().join('+'), label.class]));
      const a = classOf(entry.a);
      const b = classOf(entry.b);
      for (const [first, second] of pairsOf(entry.events.map((event) => event.key))) {
        const key = [first, second].sort().join('+');
        pairs.push([a.get(key) ?? 'none', b.get(key) ?? 'none']);
        where.push(entry.caseId);
        items.push(key);
      }
    }
    addNominal('conflicts', 'a pair of events', pairs, where, items);
  }

  // causes: every named hypothesis of every case.
  {
    const scoped = cases.filter((entry) => entry.a.causes !== undefined && entry.b.causes !== undefined);
    const tally = new Binary();
    for (const entry of scoped) {
      for (const id of hypothesisIds) {
        tally.count(`${entry.caseId}#${id}`, (entry.a.causes ?? []).includes(id), (entry.b.causes ?? []).includes(id), ['a cause', 'not a cause']);
      }
    }
    addBinary('causes', 'a case and a hypothesis', scoped.length, tally, (item) => item.slice(0, item.indexOf('#')));
  }

  return { annotatorA, annotatorB, cases: cases.map((entry) => entry.caseId), kinds, disagreements };
}

// ---------------------------------------------------------------- report and command line

const fixed = (value: number | null): string => (value === null ? 'n/a' : value.toFixed(2));

export function renderAgreement(report: AgreementReport): string {
  const out: string[] = [
    `# Agreement between ${report.annotatorA} and ${report.annotatorB}`,
    '',
    `${report.cases.length} cases annotated by both.`,
    '',
    '| Label kind | Unit | Cases | Units | Observed | Kappa | Positive agreement |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
    ...report.kinds.map((entry) => {
      const positive = 'positiveAgreement' in entry.agreement ? fixed(entry.agreement.positiveAgreement) : '-';
      return `| ${entry.kind} | ${entry.unit} | ${entry.cases} | ${entry.agreement.n} | ${fixed(entry.agreement.observed)} | ${fixed(entry.agreement.kappa)} | ${positive} |`;
    }),
    '',
    `## Disagreements to adjudicate (${report.disagreements.length})`,
    '',
    '| Case | Kind | Item | ' + report.annotatorA + ' | ' + report.annotatorB + ' |',
    '| --- | --- | --- | --- | --- |',
    ...report.disagreements.map((entry) => `| ${entry.caseId} | ${entry.kind} | ${entry.item} | ${entry.a} | ${entry.b} |`),
    '',
    'Record a decision in the case annotation file, under `adjudication`: for each field the two disagree on, the accepted value and why.',
    'Two AI drafts that agree show that the assistant is consistent. They are not a human reference.',
    '',
  ];
  return out.join('\n');
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  const [annotatorA, annotatorB] = args.filter((arg) => !arg.startsWith('--'));
  const splitIndex = args.indexOf('--split');
  const splits: Split[] =
    splitIndex >= 0 ? [args[splitIndex + 1] as Split].filter((split) => SPLITS.includes(split)) : ['dev', 'validation'];
  if (!annotatorA || !annotatorB) {
    process.stderr.write('usage: agreement.ts <annotator A> <annotator B> [--split dev|validation|test]\n');
    process.exitCode = 1;
  } else {
    const dataset = loadDataset({ root: EVALUATION_ROOT, splits });
    const cases: AgreementCase[] = [];
    for (const loaded of dataset.cases) {
      if (!loaded.annotations) continue;
      const latest = latestRecords(loaded.annotations);
      const a = latest.find((record) => record.annotatorId === annotatorA && !record.excluded);
      const b = latest.find((record) => record.annotatorId === annotatorB && !record.excluded);
      if (a && b) cases.push({ caseId: loaded.case.id, events: loaded.case.events, a, b });
    }
    process.stdout.write(`${renderAgreement(compareAnnotators(annotatorA, annotatorB, cases, loadVocabulary(EVALUATION_ROOT)))}\n`);
  }
}
