import { diagnosticReasoning, evidenceIntegrity } from './dimensions-reasoning';
import {
  customerCommunication,
  efficiencyProportionality,
  resolutionValidation,
  scopingCompleteness,
} from './dimensions-process';
import type { QualityFacts } from './facts';
import type { DimensionDraft } from './types';

/** The six dimension results in contract order (evidence, reasoning, scoping, communication, validation, efficiency). */
export function buildDimensionDrafts(facts: QualityFacts): DimensionDraft[] {
  return [
    evidenceIntegrity(facts),
    diagnosticReasoning(facts),
    scopingCompleteness(facts),
    customerCommunication(facts),
    resolutionValidation(facts),
    efficiencyProportionality(facts),
  ];
}
