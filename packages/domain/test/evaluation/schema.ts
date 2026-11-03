import { z } from 'zod';
import {
  CONFLICT_CLASSES,
  ChannelSchema,
  EventTypeSchema,
  FORK_CATEGORIES,
  IsoTimestampSchema,
  QualityBandSchema,
} from '@caseguard/schemas';
import { ABSENT_REASONS, type AbsentReason } from './vocabulary';

/**
 * The data formats of the evaluation set (framework v2). Everything under `evaluation/` is JSON checked by these
 * schemas: cases (events only), annotations (labels, one file per case), annotators, the manifest and the log of locked
 * runs. Nothing in this file knows the engine; the reasons an absence can have come from the vocabulary module.
 */

export const EVAL_CASE_SCHEMA = 'caseguard.eval-case/2' as const;
export const EVAL_ANNOTATIONS_SCHEMA = 'caseguard.eval-annotations/2' as const;
export const EVAL_ANNOTATORS_SCHEMA = 'caseguard.eval-annotators/1' as const;
export const EVAL_MANIFEST_SCHEMA = 'caseguard.eval-manifest/1' as const;
export const EVAL_LOCKED_RUNS_SCHEMA = 'caseguard.eval-locked-runs/1' as const;
export const EVAL_RUN_SCHEMA = 'caseguard.eval-run/1' as const;
export const EVAL_DRAFT_SCHEMA = 'caseguard.eval-annotation-draft/1' as const;

// ---------------------------------------------------------------- splits, ids, categories

/** dev: tuned on. validation: checked, never tuned on. test: locked, run only by `eval:locked`. */
export const SPLITS = ['dev', 'validation', 'test'] as const;
export type Split = (typeof SPLITS)[number];
export const SPLIT_LETTER: Readonly<Record<Split, 'd' | 'v' | 't'>> = {
  dev: 'd',
  validation: 'v',
  test: 't',
};
export const LETTER_SPLIT: Readonly<Record<string, Split>> = { d: 'dev', v: 'validation', t: 'test' };

/** `ev-d-014-gdansk-conditional-access`: prefix, split letter, number, slug. */
export const CASE_ID_PATTERN = /^ev-([dvt])-(\d{3})-([a-z0-9]+(?:-[a-z0-9]+)*)$/;
export const FAMILY_PATTERN = /^fam-\d{3}$/;
export const EVENT_KEY_PATTERN = /^ev\d{2,3}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export const CASE_CATEGORIES = [
  'paraphrase',
  'noisy',
  'reordered',
  'negative-control',
  'negation',
  'contradiction',
  'unsupported',
] as const;
export type CaseCategory = (typeof CASE_CATEGORIES)[number];

export const EVAL_WHO = ['customer', 'network', 'enduser', 'engineer', 'system'] as const;
export type EvalWho = (typeof EVAL_WHO)[number];

export const WORKLOAD_WITH_PACK = 'teams-authentication';

export { ABSENT_REASONS, type AbsentReason };
/** The reasons the negation measure reads; `other` marks an absence that is not about modality. */
export const NEGATION_REASONS: ReadonlySet<string> = new Set(
  ABSENT_REASONS.filter((reason) => reason !== 'other'),
);

export const UNCERTAINTY_LEVELS = ['none', 'low', 'medium', 'high'] as const;
export type UncertaintyLevel = (typeof UNCERTAINTY_LEVELS)[number];

const EventKey = z.string().regex(EVENT_KEY_PATTERN);

// ---------------------------------------------------------------- cases

export const EvalEventSchema = z.strictObject({
  key: EventKey,
  /** Minutes after the case was opened. */
  at: z.number().int().min(0).max(60 * 24 * 60),
  who: z.enum(EVAL_WHO),
  type: EventTypeSchema,
  channel: ChannelSchema,
  title: z.string().min(1).max(200).optional(),
  /** Plain text only: no structured fields, no action metadata. */
  text: z.string().min(1).max(20_000),
});
export type EvalEvent = z.infer<typeof EvalEventSchema>;

export const EvalCaseSchema = z.strictObject({
  schema: z.literal(EVAL_CASE_SCHEMA),
  id: z.string().regex(CASE_ID_PATTERN).max(64),
  split: z.enum(SPLITS),
  /** All variants of one scenario share a family, and a family lives in exactly one split. */
  family: z.string().regex(FAMILY_PATTERN),
  title: z.string().min(5).max(200),
  scenario: z.string().min(10).max(600),
  categories: z.array(z.enum(CASE_CATEGORIES)).min(1).max(CASE_CATEGORIES.length),
  workload: z.string().min(1).max(80),
  openedAt: IsoTimestampSchema,
  /** A reordered copy names the case it repeats and has no labels of its own. */
  derivedFrom: z.string().regex(CASE_ID_PATTERN).nullable(),
  /** For a reordered copy: the event keys in the order they are handed to the engine. */
  handedOverOrder: z.array(EventKey).min(2).nullable(),
  events: z.array(EvalEventSchema).min(1).max(60),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

// ---------------------------------------------------------------- annotations

const Uncertainty = z.enum(UNCERTAINTY_LEVELS);
const Note = z.string().min(1).max(400).optional();

export const SignalLabelSchema = z.strictObject({
  event: EventKey,
  id: z.string().regex(/^sig\./),
  uncertainty: Uncertainty.optional(),
  note: Note,
});
export type SignalLabel = z.infer<typeof SignalLabelSchema>;

export const ActionLabelSchema = z.strictObject({
  event: EventKey,
  id: z.string().regex(/^act\./),
  uncertainty: Uncertainty.optional(),
  note: Note,
});
export type ActionLabel = z.infer<typeof ActionLabelSchema>;

/** The words of a signal or an action appear in the event, and the fact must not be read from them. */
export const AbsentLabelSchema = z.strictObject({
  event: EventKey,
  id: z.string().regex(/^(sig|act)\./),
  reason: z.enum(ABSENT_REASONS),
  note: Note,
});
export type AbsentLabel = z.infer<typeof AbsentLabelSchema>;

export const ForkLabelSchema = z.strictObject({
  event: EventKey,
  category: z.enum(FORK_CATEGORIES),
  note: Note,
});
export type ForkLabel = z.infer<typeof ForkLabelSchema>;

export const ConflictLabelSchema = z.strictObject({
  class: z.enum(CONFLICT_CLASSES),
  /** Both sides, the earlier one first. */
  events: z.tuple([EventKey, EventKey]),
  /** A signal id or a short key of the thing both sides are about. */
  subject: z.string().min(1).max(120),
  note: z.string().min(1).max(400).optional(),
});
export type ConflictLabel = z.infer<typeof ConflictLabelSchema>;

export const COUNTERFACTUAL_DIRECTIONS = ['better', 'none', 'unclear'] as const;
export type CounterfactualDirection = (typeof COUNTERFACTUAL_DIRECTIONS)[number];

/** The kinds of label a record can carry. A kind that is absent from a record was not annotated. */
export const LABEL_KINDS = [
  'signals',
  'actions',
  'absent',
  'forks',
  'earliestMissed',
  'counterfactualDirection',
  'conflicts',
  'qualityBand',
  'causes',
] as const;
export type LabelKind = (typeof LABEL_KINDS)[number];

const LABEL_VALUE_SCHEMAS = {
  signals: z.array(SignalLabelSchema),
  actions: z.array(ActionLabelSchema),
  absent: z.array(AbsentLabelSchema),
  forks: z.array(ForkLabelSchema),
  earliestMissed: EventKey.nullable(),
  counterfactualDirection: z.enum(COUNTERFACTUAL_DIRECTIONS),
  conflicts: z.array(ConflictLabelSchema),
  qualityBand: QualityBandSchema.nullable(),
  causes: z.array(z.string().regex(/^hyp\./)),
} as const;
export const labelValueSchema = (kind: LabelKind): z.ZodType => LABEL_VALUE_SCHEMAS[kind];

export const ANNOTATOR_KINDS = ['human', 'ai_draft'] as const;
export type AnnotatorKind = (typeof ANNOTATOR_KINDS)[number];

/**
 * One annotator's labels for one case. `signals` is exhaustive per event; `actions` is exhaustive on the events an
 * engineer wrote. A kind that is left out was not annotated and the measures skip it; `[]` or `null` is an answer.
 */
export const AnnotationRecordSchema = z.strictObject({
  annotatorId: z.string().min(1).max(80),
  kind: z.enum(ANNOTATOR_KINDS),
  version: z.number().int().min(1),
  annotatedAt: IsoTimestampSchema,
  excluded: z.boolean(),
  exclusionReason: z.string().min(1).max(400).nullable(),
  signals: LABEL_VALUE_SCHEMAS.signals,
  actions: LABEL_VALUE_SCHEMAS.actions.optional(),
  absent: LABEL_VALUE_SCHEMAS.absent.optional(),
  forks: LABEL_VALUE_SCHEMAS.forks.optional(),
  earliestMissed: LABEL_VALUE_SCHEMAS.earliestMissed.optional(),
  counterfactualDirection: LABEL_VALUE_SCHEMAS.counterfactualDirection.optional(),
  conflicts: LABEL_VALUE_SCHEMAS.conflicts.optional(),
  qualityBand: LABEL_VALUE_SCHEMAS.qualityBand.optional(),
  causes: LABEL_VALUE_SCHEMAS.causes.optional(),
  rationale: z.string().min(1).max(2400),
  uncertainty: Uncertainty,
});
export type AnnotationRecord = z.infer<typeof AnnotationRecordSchema>;

export const ADJUDICATION_STATUSES = ['single_annotator', 'agreed', 'adjudicated', 'excluded'] as const;

export const AdjudicationSchema = z.strictObject({
  status: z.enum(ADJUDICATION_STATUSES),
  /** The annotator whose record is the base of the accepted labels. */
  acceptedFrom: z.string().min(1).max(80),
  decidedBy: z.string().min(1).max(80),
  decidedAt: IsoTimestampSchema,
  version: z.number().int().min(1),
  disagreements: z.array(
    z.strictObject({
      field: z.enum(LABEL_KINDS),
      values: z.record(z.string(), z.unknown()),
      /** The value accepted for the field; it replaces the base record's value. */
      accepted: z.unknown(),
      rationale: z.string().min(1).max(800),
    }),
  ),
});
export type Adjudication = z.infer<typeof AdjudicationSchema>;

export const AnnotationFileSchema = z.strictObject({
  schema: z.literal(EVAL_ANNOTATIONS_SCHEMA),
  caseId: z.string().regex(CASE_ID_PATTERN),
  annotations: z.array(AnnotationRecordSchema).min(1),
  adjudication: AdjudicationSchema.nullable(),
});
export type AnnotationFile = z.infer<typeof AnnotationFileSchema>;

/** What `eval:annotate` writes for a second annotator: one empty record, with no other annotator's labels in it. */
export const AnnotationDraftSchema = z.strictObject({
  schema: z.literal(EVAL_DRAFT_SCHEMA),
  caseId: z.string().regex(CASE_ID_PATTERN),
  instructions: z.array(z.string()),
  record: AnnotationRecordSchema,
});
export type AnnotationDraft = z.infer<typeof AnnotationDraftSchema>;

// ---------------------------------------------------------------- annotators, manifest, locked runs

export const AnnotatorSchema = z.strictObject({
  id: z.string().min(1).max(80),
  kind: z.enum(ANNOTATOR_KINDS),
  description: z.string().min(1).max(600),
  addedAt: IsoTimestampSchema,
});
export type Annotator = z.infer<typeof AnnotatorSchema>;

export const AnnotatorRegistrySchema = z.strictObject({
  schema: z.literal(EVAL_ANNOTATORS_SCHEMA),
  annotators: z.array(AnnotatorSchema).min(1),
});
export type AnnotatorRegistry = z.infer<typeof AnnotatorRegistrySchema>;

export const ManifestCaseSchema = z.strictObject({
  split: z.enum(SPLITS),
  family: z.string().regex(FAMILY_PATTERN),
  derivedFrom: z.string().regex(CASE_ID_PATTERN).nullable(),
  /** Hash of the case file (events only). Immutable once the split is locked. */
  eventsSha256: z.string().regex(SHA256),
  /** Hash of the annotation file; null for a reordered copy, which has no labels of its own. */
  annotationsSha256: z.string().regex(SHA256).nullable(),
});

export const ManifestSchema = z.strictObject({
  schema: z.literal(EVAL_MANIFEST_SCHEMA),
  datasetVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  /** Bumped whenever any annotation file changes. */
  annotationVersion: z.number().int().min(1),
  splits: z.strictObject({
    dev: z.array(z.string().regex(CASE_ID_PATTERN)),
    validation: z.array(z.string().regex(CASE_ID_PATTERN)),
    test: z.array(z.string().regex(CASE_ID_PATTERN)),
  }),
  cases: z.record(z.string(), ManifestCaseSchema),
  /** Filled by whoever locks the test split (`eval:manifest --lock`); null until then. */
  locked: z
    .strictObject({
      at: IsoTimestampSchema,
      commit: z.string().regex(/^[0-9a-f]{40}$/),
      testSetSha256: z.string().regex(SHA256),
    })
    .nullable(),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export const LockedRunRecordSchema = z.strictObject({
  index: z.number().int().min(1),
  ranAt: IsoTimestampSchema,
  gitCommit: z.string().regex(/^[0-9a-f]{40}$/),
  engineVersion: z.string().min(1),
  packId: z.string().min(1),
  packVersion: z.string().min(1),
  packSha256: z.string().regex(SHA256),
  /** Hash of the case files (events) that were run. */
  caseSetSha256: z.string().regex(SHA256),
  /** The lock's hash of the whole test split (cases and annotations). */
  testSetSha256: z.string().regex(SHA256),
  resultsSha256: z.string().regex(SHA256),
  /** Whether per-case detail was printed. It must never be used to change a detector. */
  detail: z.boolean(),
  previous: z.string().regex(SHA256).nullable(),
  hash: z.string().regex(SHA256),
});
export type LockedRunRecord = z.infer<typeof LockedRunRecordSchema>;

export const LockedRunsSchema = z.strictObject({
  schema: z.literal(EVAL_LOCKED_RUNS_SCHEMA),
  runs: z.array(LockedRunRecordSchema),
});
export type LockedRuns = z.infer<typeof LockedRunsSchema>;
