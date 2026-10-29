/** Shapes of the constants in `generated.ts` (written by `scripts/export-samples.ts`). */

/** One built-in synthetic case bundle, embedded so the container needs no file-system access. */
export interface GeneratedSampleBundle {
  readonly id: string;
  /** Case One is the primary worked example; Case Two is the related follow-up case. */
  readonly role: 'primary' | 'followup';
  readonly fileName: string;
  readonly description: string;
  /** The bundle file exactly as authored (LF line endings). */
  readonly json: string;
}

export type ExampleKind = 'case_bundle' | 'transcript' | 'csv';

/** One downloadable example input file (all synthetic). */
export interface GeneratedExampleFile {
  readonly id: string;
  readonly kind: ExampleKind;
  readonly title: string;
  readonly description: string;
  readonly fileName: string;
  readonly mediaType: string;
  /** The file exactly as authored (LF line endings). */
  readonly text: string;
}
