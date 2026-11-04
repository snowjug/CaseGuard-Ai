import { describe, expect, it } from 'vitest';
import { checkUnsupportedCertainty } from '../../../src/reasoning/rules/unsupported-certainty';
import { parsed } from '../fixtures';

const codes = (p: ReturnType<typeof parsed>) =>
  checkUnsupportedCertainty(p).map((i) => [i.code, i.path]);

describe('rule unsupported_certainty', () => {
  it('lets high confidence through when the record states or paraphrases it', () => {
    expect(
      codes(parsed('signal', { confidence: 'high', confidenceBasis: 'stated_in_record' })),
    ).toEqual([]);
    expect(
      codes(parsed('signal', { confidence: 'high', confidenceBasis: 'paraphrase_of_record' })),
    ).toEqual([]);
  });

  it.each(['inferred_from_sequence', 'inferred_from_absence', 'general_knowledge'] as const)(
    'refuses high confidence on the basis %s',
    (basis) => {
      expect(codes(parsed('missed_step', { confidence: 'high', confidenceBasis: basis }))).toEqual([
        ['unsupported_certainty', 'confidence'],
      ]);
    },
  );

  it('lets medium and low confidence through on any basis', () => {
    for (const confidence of ['medium', 'low'] as const) {
      expect(
        codes(parsed('counterfactual', { confidence, confidenceBasis: 'inferred_from_sequence' })),
      ).toEqual([]);
    }
  });

  it.each([
    'This is definitely the cause.',
    'It certainly was not DNS.',
    'The log proves the policy is at fault.',
    'The change is guaranteed to fix it.',
    'We are 100% sure.',
    'It is undoubtedly a routing problem.',
    'Without a doubt the proxy failed.',
    'The cause is conclusively known.',
    'This is absolutely a token problem.',
    'There is no doubt about it.',
  ])('refuses absolute wording on an inferred basis: %s', (statement) => {
    expect(
      codes(
        parsed('signal', {
          statement,
          confidenceBasis: 'inferred_from_sequence',
          confidence: 'medium',
        }),
      ),
    ).toEqual([['unsupported_certainty', 'statement']]);
  });

  it('refuses absolute wording in the reasoning, the payload and the uncertainty note too', () => {
    const base = { confidenceBasis: 'inferred_from_absence', confidence: 'low' } as const;
    expect(codes(parsed('signal', { ...base, reasoning: 'It definitely is.' }))[0]?.[1]).toBe(
      'reasoning',
    );
    expect(
      codes(
        parsed('recommendation', { ...base, rationale: 'This will certainly fix it.' }),
      )[0]?.[1],
    ).toBe('rationale');
    expect(
      codes(
        parsed('signal', {
          ...base,
          uncertainty: { level: 'low', note: 'Guaranteed to be right.' },
        }),
      )[0]?.[1],
    ).toBe('uncertainty.note');
  });

  it('lets absolute wording through when the record states the thing', () => {
    expect(
      codes(
        parsed('signal', {
          statement: 'The engineer definitely stated the cause.',
          confidenceBasis: 'stated_in_record',
        }),
      ),
    ).toEqual([]);
  });

  it('does not read what the model quoted: the record may say "definitely"', () => {
    expect(
      codes(
        parsed('signal', {
          confidenceBasis: 'inferred_from_sequence',
          confidence: 'low',
          evidence: [{ eventId: 'e3', excerpt: 'The sign-in log shows AADSTS50076' }],
          statement: 'The log shows an MFA error.',
        }),
      ),
    ).toEqual([]);
  });

  it('does not mistake ordinary words for absolute ones', () => {
    for (const statement of [
      'The engineer is certain the logs were checked.',
      'The proof of concept was never run.',
      'The customer reports 100 users affected.',
      'Approximately 100% of the sampled sign-ins failed.',
    ]) {
      // "certain" alone and "100 users" are not absolute claims; "100%" is, and is flagged separately below.
      const result = codes(
        parsed('signal', {
          statement,
          confidenceBasis: 'inferred_from_sequence',
          confidence: 'low',
        }),
      );
      expect(result.length).toBe(statement.includes('100%') ? 1 : 0);
    }
  });

  it('reports both problems when both are there', () => {
    expect(
      codes(
        parsed('signal', {
          statement: 'It proves the point.',
          confidence: 'high',
          confidenceBasis: 'general_knowledge',
        }),
      ).map((i) => i[1]),
    ).toEqual(['confidence', 'statement']);
  });
});
