import { describe, expect, it } from 'vitest';
import {
  checkExcessiveOutput,
  checkReplySize,
  splitOverflow,
} from '../../../src/reasoning/rules/excessive-output';
import { proposal } from '../fixtures';

const codes = (type: Parameters<typeof checkExcessiveOutput>[0], raw: unknown) =>
  checkExcessiveOutput(type, raw).map((i) => i.code);

describe('rule excessive_output', () => {
  it('lets a proposal within every cap through, caps included', () => {
    expect(codes('signal', proposal('signal'))).toEqual([]);
    expect(
      codes(
        'signal',
        proposal('signal', {
          statement: 'x'.repeat(300),
          reasoning: 'y'.repeat(500),
          evidence: Array.from({ length: 6 }, () => ({ eventId: 'e3', excerpt: 'z'.repeat(300) })),
        }),
      ),
    ).toEqual([]);
  });

  it.each([
    ['a statement of 301 characters', { statement: 'x'.repeat(301) }, 'statement'],
    ['a reasoning of 501 characters', { reasoning: 'x'.repeat(501) }, 'reasoning'],
    [
      'a quotation of 301 characters',
      { evidence: [{ eventId: 'e3', excerpt: 'x'.repeat(301) }] },
      'evidence[0].excerpt',
    ],
    [
      'seven citations',
      {
        evidence: Array.from({ length: 7 }, () => ({ eventId: 'e3', excerpt: 'The sign-in log' })),
      },
      'evidence',
    ],
    [
      'five notes on what cuts against it',
      { contradictions: Array.from({ length: 5 }, () => ({ eventId: 'e1', note: 'Opposes it.' })) },
      'contradictions',
    ],
    [
      'an uncertainty note of 301 characters',
      { uncertainty: { level: 'low', note: 'n'.repeat(301) } },
      'uncertainty.note',
    ],
  ])('reports %s', (_name, patch, path) => {
    const issues = checkExcessiveOutput('signal', proposal('signal', patch));
    expect(issues.map((i) => i.code)).toEqual(['excessive_output']);
    expect(issues[0]?.path).toBe(path);
  });

  it('applies the caps of each type', () => {
    expect(
      codes(
        'contradiction',
        proposal('contradiction', {
          sides: [1, 2, 3].map(() => ({ eventId: 'e1', statement: 's' })),
        }),
      ),
    ).toEqual(['excessive_output']);
    expect(
      codes('missed_step', proposal('missed_step', { availableEventIds: Array(9).fill('e1') })),
    ).toEqual(['excessive_output']);
    expect(
      codes(
        'counterfactual',
        proposal('counterfactual', { constraints: Array(5).fill('A constraint') }),
      ),
    ).toEqual(['excessive_output']);
    expect(
      codes('case_synthesis', proposal('case_synthesis', { summary: 's'.repeat(801) })),
    ).toEqual(['excessive_output']);
  });

  it('does not report what is merely wrong in shape', () => {
    expect(codes('signal', proposal('signal', { confidence: 'certain', extra: 1 }))).toEqual([]);
  });

  it('refuses a reply that is larger as a whole', () => {
    expect(checkReplySize(64_000, 64_000)).toEqual([]);
    const [issue] = checkReplySize(64_001, 64_000);
    expect(issue).toMatchObject({ code: 'excessive_output', path: '$' });
    expect(issue?.message).toContain('64000');
  });

  it('keeps the first items of a list and reports each one past the cap', () => {
    const { within, overflow } = splitOverflow(['a', 'b', 'c', 'd', 'e'], 3, 'signals');
    expect(within).toEqual(['a', 'b', 'c']);
    expect(overflow.map((i) => i.path)).toEqual(['signals[3]', 'signals[4]']);
    expect(overflow.every((i) => i.code === 'excessive_output')).toBe(true);
    expect(splitOverflow([1, 2], 3, 'x').overflow).toEqual([]);
  });
});
