import type { QualityBand } from '@caseguard/schemas';
import type { Dataset, LoadedCase } from './dataset';
import {
  labelValueSchema,
  LABEL_KINDS,
  type AbsentLabel,
  type ActionLabel,
  type AnnotationFile,
  type AnnotationRecord,
  type AnnotatorKind,
  type ConflictLabel,
  type CounterfactualDirection,
  type ForkLabel,
  type LabelKind,
  type SignalLabel,
} from './schema';

/** What the measures read: the labels of one case that are accepted as the reference. */
export interface LabelSet {
  readonly signals: readonly SignalLabel[];
  /** Each of the following is undefined when that kind was not annotated: the measures skip it. */
  readonly actions?: readonly ActionLabel[] | undefined;
  readonly absent?: readonly AbsentLabel[] | undefined;
  readonly forks?: readonly ForkLabel[] | undefined;
  readonly earliestMissed?: string | null | undefined;
  readonly counterfactualDirection?: CounterfactualDirection | undefined;
  readonly conflicts?: readonly ConflictLabel[] | undefined;
  readonly qualityBand?: QualityBand | null | undefined;
  readonly causes?: readonly string[] | undefined;
}

/**
 * - `single_annotator`: one annotator's labels, as they are.
 * - `agreed` / `adjudicated`: two or more annotators and a recorded decision.
 * - `unadjudicated`: two or more annotators and no (or a stale) decision: reported, never counted.
 * - `excluded`: the case must not be measured.
 */
export type LabelStatus =
  | 'single_annotator'
  | 'agreed'
  | 'adjudicated'
  | 'unadjudicated'
  | 'excluded';

export interface AcceptedLabels {
  readonly status: LabelStatus;
  /** The annotators whose records were read (the latest version of each). */
  readonly annotators: readonly string[];
  readonly annotatorKinds: readonly AnnotatorKind[];
  /** The annotator whose record is the base of `labels`; null when there are none. */
  readonly acceptedFrom: string | null;
  /** Null when the status is `unadjudicated` or `excluded`: nothing is counted. */
  readonly labels: LabelSet | null;
  readonly note: string | null;
}

const labelsOf = (record: AnnotationRecord): LabelSet => ({
  signals: record.signals,
  actions: record.actions,
  absent: record.absent,
  forks: record.forks,
  earliestMissed: record.earliestMissed,
  counterfactualDirection: record.counterfactualDirection,
  conflicts: record.conflicts,
  qualityBand: record.qualityBand,
  causes: record.causes,
});

/** The latest version of each annotator's record, in the order of first appearance. */
export function latestRecords(file: AnnotationFile): AnnotationRecord[] {
  const byAnnotator = new Map<string, AnnotationRecord>();
  for (const record of file.annotations) {
    const known = byAnnotator.get(record.annotatorId);
    if (!known || record.version > known.version) byAnnotator.set(record.annotatorId, record);
  }
  return [...byAnnotator.values()];
}

/** A value for a label kind, as an adjudication accepted it. */
function overlay(base: LabelSet, kind: LabelKind, value: unknown): LabelSet {
  const parsed = labelValueSchema(kind).safeParse(value);
  if (!parsed.success) throw new Error(`the accepted value of "${kind}" is not a valid ${kind} label`);
  return { ...base, [kind]: parsed.data };
}

/** Decides which labels of a case count as the reference. */
export function acceptLabels(file: AnnotationFile): AcceptedLabels {
  const records = latestRecords(file);
  const annotators = records.map((record) => record.annotatorId);
  const annotatorKinds = [...new Set(records.map((record) => record.kind))];
  const base = { annotators, annotatorKinds };
  const adjudication = file.adjudication;

  if (adjudication?.status === 'excluded') {
    return { ...base, status: 'excluded', acceptedFrom: null, labels: null, note: 'excluded by adjudication' };
  }
  const only = records.length === 1 ? records[0] : undefined;
  if (only) {
    if (only.excluded) {
      return {
        ...base,
        status: 'excluded',
        acceptedFrom: only.annotatorId,
        labels: null,
        note: only.exclusionReason,
      };
    }
    return { ...base, status: 'single_annotator', acceptedFrom: only.annotatorId, labels: labelsOf(only), note: null };
  }

  if (!adjudication) {
    return { ...base, status: 'unadjudicated', acceptedFrom: null, labels: null, note: 'two annotators, no decision' };
  }
  const newest = records.reduce((latest, record) => (record.annotatedAt > latest ? record.annotatedAt : latest), '');
  if (newest > adjudication.decidedAt) {
    return {
      ...base,
      status: 'unadjudicated',
      acceptedFrom: null,
      labels: null,
      note: 'a record is newer than the decision',
    };
  }
  const source = records.find((record) => record.annotatorId === adjudication.acceptedFrom);
  if (!source) throw new Error(`the adjudication accepts a record of "${adjudication.acceptedFrom}", which does not exist`);
  if (source.excluded) {
    return { ...base, status: 'excluded', acceptedFrom: source.annotatorId, labels: null, note: source.exclusionReason };
  }
  let labels = labelsOf(source);
  for (const disagreement of adjudication.disagreements) {
    labels = overlay(labels, disagreement.field, disagreement.accepted);
  }
  return {
    ...base,
    status: adjudication.status === 'agreed' ? 'agreed' : 'adjudicated',
    acceptedFrom: source.annotatorId,
    labels,
    note: null,
  };
}

/**
 * The accepted labels of a loaded case. A reordered copy has none of its own and repeats those of its source; a case
 * without an annotation file has none at all.
 */
export function acceptedFor(dataset: Dataset, loaded: LoadedCase): AcceptedLabels | null {
  const { derivedFrom } = loaded.case;
  if (derivedFrom !== null) {
    const source = dataset.cases.find((candidate) => candidate.case.id === derivedFrom);
    return source ? acceptedFor(dataset, source) : null;
  }
  return loaded.annotations ? acceptLabels(loaded.annotations) : null;
}

/** Which label kinds a set of labels covers. */
export function annotatedKinds(labels: LabelSet): LabelKind[] {
  return LABEL_KINDS.filter((kind) => labels[kind] !== undefined);
}
