import { describe, expect, it } from 'vitest';
import { CASE_ONE, CASE_TWO, type CaseFixture } from '../../../../test/review-fixtures';
import { deriveNextActions } from './actions';
import { shareSummary, type ShareInput } from './summary';
import { deriveMissedMoment, deriveVerdict } from './verdict';

function inputOf(fixture: CaseFixture, override: Partial<ShareInput> = {}): ShareInput {
  return {
    reference: fixture.detail.reference,
    title: fixture.detail.title,
    synthetic: fixture.detail.synthetic,
    verdict: deriveVerdict({
      quality: fixture.quality,
      coaching: fixture.coaching,
      forks: fixture.forks,
      detail: fixture.detail,
      metrics: fixture.metrics,
    }),
    missed: deriveMissedMoment(fixture.forks),
    actions: deriveNextActions({
      quality: fixture.quality,
      warnings: fixture.warnings,
      coaching: fixture.coaching,
      ranking: fixture.ranking,
    }),
    reportUrl: 'https://caseguard.example/cases/case_1/report',
    notIncluded: [],
    ...override,
  };
}

describe('[REV-SHARE-01] the short share summary', () => {
  it('says the verdict, the earliest missed moment and the first recommendations, labelled as estimates', () => {
    const text = shareSummary(inputOf(CASE_ONE));
    const lines = text.split('\n');
    expect(lines[0]).toBe(
      `CaseGuard guided review: ${CASE_ONE.detail.reference}, ${CASE_ONE.detail.title}`,
    );
    expect(lines[1]).toBe(
      'Case quality is poor: about 36 out of 100 (plausible range 32 to 39). This is an estimate.',
    );
    expect(text).toContain(
      'Earliest important missed moment: Heavy customer request when a lighter ask was available',
    );
    expect(text).toContain('Next actions:\n1. ');
    expect(text).toContain('\n3. ');
    expect(text).not.toContain('\n4. ');
    expect(text).toContain('simulated figures are what-ifs, not measurements');
    expect(text).toContain('This case uses synthetic data.');
    expect(text.endsWith('Full report: https://caseguard.example/cases/case_1/report')).toBe(true);
  });

  it('lists the recommendations most urgent first, as the review does', () => {
    const model = deriveNextActions({
      quality: CASE_ONE.quality,
      warnings: CASE_ONE.warnings,
      coaching: CASE_ONE.coaching,
      ranking: CASE_ONE.ranking,
    });
    const text = shareSummary(inputOf(CASE_ONE));
    model.items.slice(0, 3).forEach((item, index) => {
      expect(text).toContain(`${index + 1}. ${item.title} (${item.priorityLabel.toLowerCase()})`);
    });
  });

  it('names what could not be read instead of leaving it out in silence', () => {
    const text = shareSummary(
      inputOf(CASE_ONE, {
        verdict: null,
        missed: undefined,
        actions: null,
        notIncluded: [
          'the case quality result (your role cannot read it)',
          'the decision points (they could not be read)',
        ],
      }),
    );
    expect(text).not.toContain('Case quality is');
    expect(text).not.toContain('missed moment');
    expect(text).not.toContain('Next actions:');
    expect(text).toContain(
      'Not included: the case quality result (your role cannot read it); the decision points (they could not be read).',
    );
  });

  it('says so when no decision point stood out, and keeps a strong case honest', () => {
    const text = shareSummary(inputOf(CASE_TWO));
    expect(text).toContain(
      'No decision point stood out as having a clearly better step available.',
    );
    expect(text).toContain('Case quality is strong');
    expect(text).not.toContain('Earliest important missed moment');
  });
});
