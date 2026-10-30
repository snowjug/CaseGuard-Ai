import { sampleByRole, sampleInfo } from '../../samples';

/** One of the two built-in synthetic cases the story is told with. */
export interface StoryCase {
  /** The id `ingestion.ingest` accepts for a built-in sample. */
  readonly sampleId: string;
  /** The case reference inside the bundle: how an ingested copy is recognised later. */
  readonly reference: string;
}

function storyCase(role: 'primary' | 'followup'): StoryCase {
  const info = sampleInfo(sampleByRole(role));
  return { sampleId: info.id, reference: info.reference };
}

/**
 * Case One (an inefficient investigation) and Case Two (the related, efficient follow-up). Read once
 * from the generated samples: the references never change while the process runs.
 */
export const STORY_CASES: { readonly one: StoryCase; readonly two: StoryCase } = {
  one: storyCase('primary'),
  two: storyCase('followup'),
};
