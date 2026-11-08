import type { QualityAssessment, QualityBand, QualityDimensionKey } from '@caseguard/schemas';
import { BAND_WORDS } from '../review/model/verdict';

/**
 * The words and status of a quality band. They come from the review's verdict table, so the Review and the Score say
 * the same thing about the same case.
 */
export const bandOf = (band: QualityBand): (typeof BAND_WORDS)[QualityBand] => BAND_WORDS[band];

/** A dimension of the index in plain words, and what it checks (the technical name goes in a tooltip). */
export interface DimensionCopy {
  name: string;
  definition: string;
}

/** The six dimensions, named for a person who has never read the scoring configuration. */
export const DIMENSION_COPY: Record<QualityDimensionKey, DimensionCopy> = {
  evidence_integrity: {
    name: 'Claims backed by evidence',
    definition:
      'Whether conclusions rest on diagnostic evidence, contradicting evidence is acknowledged and assumptions are labelled as assumptions.',
  },
  diagnostic_reasoning: {
    name: 'Sound decisions',
    definition:
      'Whether each decision was sound at the time it was made, the working hypothesis followed the evidence and risky changes followed a justified diagnosis.',
  },
  scoping_completeness: {
    name: 'Problem scoped well',
    definition:
      'Whether scope, impact and key identifiers were captured, the first request to the customer was targeted and the minimum evidence was in hand before escalating.',
  },
  customer_communication: {
    name: 'Customer kept informed',
    definition:
      'Whether replies were prompt, expectations and next steps were set, and the customer never had to chase for news.',
  },
  resolution_validation: {
    name: 'Diagnosis confirmed',
    definition: 'Whether a diagnosis was confirmed before the case was closed.',
  },
  efficiency_proportionality: {
    name: 'Effort kept proportionate',
    definition:
      'Whether steps added information rather than repeating work, the effort asked of the customer was proportionate and the evidence became a confirmed diagnosis promptly.',
  },
};

/**
 * True when nothing could be assessed from what was known (every dimension has weight 0). The API then reports a neutral
 * 50 with the full 0 to 100 range: a placeholder, not a result, so the page never shows it as a score.
 */
export function isPlaceholderScore(assessment: Pick<QualityAssessment, 'dimensions'>): boolean {
  return assessment.dimensions.every((dimension) => dimension.weight === 0);
}

/** A dimension that was left out of the composite because it could not be assessed yet (weight 0). */
export function isLeftOut(dimension: { weight: number }): boolean {
  return dimension.weight === 0;
}

/** Percentage of the composite a dimension carries, for display. */
export function weightText(weight: number): string {
  return `${Math.round(weight * 1000) / 10}%`;
}
