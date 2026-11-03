import type { CaseCategory } from './schema';

/**
 * How the 16 cases of the Wave 1 corpus (`corpus-*.ts` of commit c5f5d96, deleted afterwards) became cases of framework v2.
 * Shared by the one-off scripts that migrate and record them, and by the test that checks the migration lost nothing.
 */

/** The Wave 1 corpus as it was committed. The engine source of this commit is the one the Wave 1 numbers came from. */
export const WAVE1_COMMIT = 'c5f5d96';
export const WAVE1_ANNOTATOR = 'copilot-wave1';

export interface MigrationPlan {
  readonly legacyId: string;
  readonly number: string;
  readonly family: string;
  readonly categories: readonly CaseCategory[];
}

/** Families keep every telling of one scenario together: the Warsaw, Utrecht and Lisbon stories exist in more than one. */
export const WAVE1_PLAN: readonly MigrationPlan[] = [
  { legacyId: 'p1-warsaw-resolver', number: '001', family: 'fam-001', categories: ['paraphrase'] },
  { legacyId: 'p2-utrecht-proxy', number: '002', family: 'fam-002', categories: ['paraphrase'] },
  { legacyId: 'p3-lisbon-access-rule', number: '003', family: 'fam-003', categories: ['paraphrase'] },
  { legacyId: 'p4-hourly-signout', number: '004', family: 'fam-004', categories: ['paraphrase'] },
  { legacyId: 'p5-single-laptop', number: '005', family: 'fam-005', categories: ['paraphrase'] },
  { legacyId: 'p6-vendor-incident', number: '006', family: 'fam-006', categories: ['paraphrase'] },
  { legacyId: 'n1-warsaw-noisy', number: '007', family: 'fam-001', categories: ['noisy'] },
  { legacyId: 'n2-utrecht-chat', number: '008', family: 'fam-002', categories: ['noisy'] },
  { legacyId: 'n3-lisbon-mixed-language', number: '009', family: 'fam-003', categories: ['noisy'] },
  { legacyId: 'z1-scheduling', number: '010', family: 'fam-007', categories: ['negative-control'] },
  { legacyId: 'z2-licence-question', number: '011', family: 'fam-008', categories: ['negative-control'] },
  { legacyId: 'z3-printer-lookalike', number: '012', family: 'fam-009', categories: ['negative-control'] },
  { legacyId: 'z4-negations', number: '013', family: 'fam-010', categories: ['negative-control', 'negation'] },
  { legacyId: 'r1-warsaw-shuffled', number: '014', family: 'fam-001', categories: ['reordered'] },
  { legacyId: 'r2-utrecht-reversed', number: '015', family: 'fam-002', categories: ['reordered'] },
  { legacyId: 'r3-warsaw-noisy-swapped', number: '016', family: 'fam-001', categories: ['reordered'] },
];

export const wave1IdOf = (plan: MigrationPlan): string => `ev-d-${plan.number}-${plan.legacyId}`;

/** The id of the migrated case for a Wave 1 id such as `p4-hourly-signout`. */
export function wave1Id(legacyId: string): string {
  const plan = WAVE1_PLAN.find((entry) => entry.legacyId === legacyId);
  if (!plan) throw new Error(`no Wave 1 case ${legacyId}`);
  return wave1IdOf(plan);
}
