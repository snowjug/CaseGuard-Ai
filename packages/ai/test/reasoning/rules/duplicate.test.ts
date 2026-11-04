import { describe, expect, it } from 'vitest';
import { checkDuplicates, signatureOf } from '../../../src/reasoning/rules/duplicate';
import { parsed, proposal } from '../fixtures';

const codes = (list: ReturnType<typeof parsed>[]) =>
  checkDuplicates(list).map((issues) => issues.map((i) => i.code));

describe('rule duplicate', () => {
  it('lets distinct proposals through, whatever their number', () => {
    expect(codes([])).toEqual([]);
    expect(
      codes([
        parsed('signal'),
        parsed('contradiction'),
        parsed('missing_evidence'),
        parsed('missed_step'),
        parsed('counterfactual'),
        parsed('recommendation'),
        parsed('case_synthesis'),
      ]),
    ).toEqual([[], [], [], [], [], [], []]);
  });

  it('drops the later of two proposals with the same id, whatever they say', () => {
    expect(codes([parsed('signal'), parsed('recommendation', { id: 's1' })])).toEqual([
      [],
      ['duplicate'],
    ]);
  });

  it('drops the later of two proposals about the same subject', () => {
    const again = parsed('signal', {
      id: 's2',
      statement: 'A different sentence about the same thing.',
    });
    expect(codes([parsed('signal'), again])).toEqual([[], ['duplicate']]);
    expect(signatureOf(parsed('signal'))).toBe(signatureOf(again));
    // The same signal at another event is another subject.
    expect(
      codes([parsed('signal'), parsed('signal', { id: 's2', eventId: 'e4', statement: 'Other.' })]),
    ).toEqual([[], []]);
  });

  it('drops the later of two proposals with the same statement, case and spacing aside', () => {
    const first = parsed('recommendation');
    const second = parsed('recommendation', {
      id: 'r2',
      action: 'A completely different action',
      statement: '  ASK for a   client trace NEXT. ',
    });
    expect(codes([first, second])).toEqual([[], ['duplicate']]);
  });

  it('treats the two sides of a contradiction as a set', () => {
    const sides = proposal('contradiction').sides as unknown[];
    const swapped = parsed('contradiction', {
      id: 'c2',
      statement: 'Same pair, other words.',
      sides: [...sides].reverse(),
    });
    expect(codes([parsed('contradiction'), swapped])).toEqual([[], ['duplicate']]);
  });

  it('names a requirement or an action by its id, and falls back to the words when there is none', () => {
    expect(
      codes([
        parsed('missing_evidence', { requirementId: null, missing: 'A client trace' }),
        parsed('missing_evidence', {
          id: 'm2',
          requirementId: null,
          missing: 'a  CLIENT trace',
          statement: 'Second.',
        }),
      ]),
    ).toEqual([[], ['duplicate']]);
    expect(
      codes([
        parsed('missed_step', { actionId: null, step: 'Compare resolvers' }),
        parsed('missed_step', {
          id: 'k2',
          actionId: null,
          step: 'Compare other things',
          statement: 'Second.',
        }),
      ]),
    ).toEqual([[], []]);
  });

  it('keeps the first of three and reports the second and the third', () => {
    const list = [
      parsed('signal'),
      parsed('signal', { id: 's2', statement: 'Again.' }),
      parsed('signal', { id: 's3', statement: 'And again.' }),
    ];
    expect(codes(list)).toEqual([[], ['duplicate'], ['duplicate']]);
  });

  it('points at the position of the repeat in the list it was given', () => {
    const [, second] = checkDuplicates([
      parsed('signal'),
      parsed('signal', { id: 's2', statement: 'Again.' }),
    ]);
    expect(second?.[0]?.path).toBe('[1]');
  });
});
