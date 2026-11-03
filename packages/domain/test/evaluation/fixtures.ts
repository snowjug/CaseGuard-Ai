import type { LabelSet } from './labels';
import type { CaseInput } from './metrics';
import type { EngineCaseOutput, EngineEventInfo } from './output';
import { EVAL_CASE_SCHEMA, type CaseCategory, type EvalCase, type EvalEvent } from './schema';

/** Small builders for the tests of the evaluation tooling. Nothing here is a case of the corpus. */

const customer = (key: string): EngineEventInfo => ({ key, type: 'customer_email', role: 'customer_admin', who: 'customer' });
const engineer = (key: string): EngineEventInfo => ({ key, type: 'engineer_email', role: 'support_engineer', who: 'engineer' });

/** Four events: a customer, an engineer, a customer, an engineer. */
export const FOUR_EVENTS: readonly EngineEventInfo[] = [customer('ev01'), engineer('ev02'), customer('ev03'), engineer('ev04')];

export function engineOutput(overrides: Partial<EngineCaseOutput> = {}): EngineCaseOutput {
  return {
    caseId: 'ev-d-901-made-up',
    refused: false,
    events: FOUR_EVENTS,
    signals: [],
    actions: [],
    forks: [],
    earliestFork: null,
    conflicts: 'not_available',
    hypotheses: [],
    citations: { total: 0, verified: 0, mismatch: 0, notCheckable: 0 },
    recommendations: null,
    qualityBand: null,
    counterfactual: null,
    missCauses: {},
    fingerprint: 'made-up',
    ...overrides,
  };
}

export function caseInput(options: {
  readonly id?: string;
  readonly categories?: readonly CaseCategory[];
  readonly labels?: LabelSet | null;
  readonly status?: CaseInput['status'];
  readonly engine?: Partial<EngineCaseOutput>;
}): CaseInput {
  const id = options.id ?? 'ev-d-901-made-up';
  return {
    id,
    split: 'dev',
    categories: options.categories ?? ['paraphrase'],
    workload: 'teams-authentication',
    status: options.status ?? 'single_annotator',
    labels: options.labels === undefined ? { signals: [] } : options.labels,
    annotators: ['someone'],
    engine: engineOutput({ caseId: id, ...options.engine }),
  };
}

export function evalEvent(key: string, at: number, who: EvalEvent['who'], text: string): EvalEvent {
  const tool = who === 'system';
  return {
    key,
    at,
    who,
    type: who === 'engineer' ? 'engineer_email' : who === 'system' ? 'system_event' : 'customer_email',
    channel: tool ? 'tool' : 'email',
    text,
  };
}

export function evalCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    schema: EVAL_CASE_SCHEMA,
    id: 'ev-d-901-made-up',
    split: 'dev',
    family: 'fam-901',
    title: 'A made-up case for a test',
    scenario: 'Nothing happens, and this is not a corpus case.',
    categories: ['paraphrase'],
    workload: 'teams-authentication',
    openedAt: '2026-06-02T08:00:00Z',
    derivedFrom: null,
    handedOverOrder: null,
    events: [
      evalEvent('ev01', 0, 'customer', 'First words of a made-up message.'),
      evalEvent('ev02', 10, 'engineer', 'A made-up reply from the engineer.'),
      evalEvent('ev03', 20, 'customer', 'Another made-up message.'),
    ],
    ...overrides,
  };
}
