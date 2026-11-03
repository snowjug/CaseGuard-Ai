import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ASSERTED,
  MODALITY_CUES,
  assessModality,
  firesFor,
  maskQuotedHistory,
  type AssessOptions,
} from '../src/engine/modality';

/** `The engineer did not [check the logs].` -> the text without brackets and the span between them. */
function span(marked: string): { text: string; start: number; end: number } {
  const open = marked.indexOf('[');
  const close = marked.indexOf(']');
  if (open < 0 || close < open) throw new Error(`mark the span with [ ] in: ${marked}`);
  const text = marked.slice(0, open) + marked.slice(open + 1, close) + marked.slice(close + 1);
  return { text, start: open, end: close - 1 };
}

const assess = (marked: string, options?: AssessOptions) => {
  const { text, start, end } = span(marked);
  return assessModality(text, start, end, options);
};

describe('every cue does what it says', () => {
  for (const cue of MODALITY_CUES) {
    it(`${cue.id}: ${cue.purpose}`, () => {
      expect(cue.fires.length).toBeGreaterThan(0);
      expect(cue.quiet.length).toBeGreaterThan(0);
      for (const sentence of cue.fires) {
        const result = assess(sentence);
        expect(result.cueId, sentence).toBe(cue.id);
        expect(result.modality, sentence).toBe(cue.modality);
      }
      for (const sentence of cue.quiet) {
        expect(assess(sentence).cueId, sentence).not.toBe(cue.id);
      }
    });
  }

  it('has distinct ids and bounded patterns', () => {
    expect(new Set(MODALITY_CUES.map((cue) => cue.id)).size).toBe(MODALITY_CUES.length);
    for (const cue of MODALITY_CUES) expect(cue.pattern.source.length).toBeLessThan(700);
  });
});

describe('the sentences a support case is full of', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['The engineer [checked the logs].', 'asserted'],
    ['The engineer did not [check the logs].', 'negated'],
    ['No [log review] was performed.', 'negated'],
    ['The customer said [the logs were checked].', 'attributed'],
    ['The engineer planned to [check the logs].', 'future_intent'],
    ['If [the logs had been checked], the cause would be known.', 'conditional'],
    ['The logs do not show [an authentication failure].', 'negated'],
    ['The logs show no evidence of [a token issue].', 'negated'],
    ['I will [check the sign-in logs] and come back to you.', 'future_intent'],
    ['It could be [a resolver problem].', 'speculative'],
    ['Please [send a HAR capture] from an affected PC.', 'requested'],
    ["Don't [clear the cache] yet.", 'negated'],
    ['There is no need to [reinstall Teams].', 'negated'],
    ['Nothing [unusual] in the sign-in logs.', 'negated'],
    ['Neither [DNS] nor the proxy was changed.', 'negated'],
    ['We have never [seen this error] before.', 'negated'],
    ['We cannot rule out [the proxy] at this point.', 'speculative'],
    ['The customer told us [the proxy was bypassed].', 'attributed'],
    ['Correction: [the policy was changed on Tuesday].', 'corrected'],
    ['[Users are signed out every hour].', 'asserted'],
  ];
  for (const [sentence, modality] of cases) {
    it(`${sentence} -> ${modality}`, () => {
      expect(assess(sentence).modality).toBe(modality);
    });
  }
});

describe('where a cue stops reaching', () => {
  it('does not carry a denial across a contrast word or a sentence end', () => {
    expect(assess('We did not change anything, but [users fail intermittently].').modality).toBe(
      'asserted',
    );
    expect(assess('Nothing was changed. [Users fail intermittently].').modality).toBe('asserted');
    expect(assess('The test was negative; [the proxy times out].').modality).toBe('asserted');
    expect(assess('Result:\n[the proxy times out]').modality).toBe('asserted');
  });

  it('does not take the dots of an address or an abbreviation for a sentence end', () => {
    expect(assess('No answer from 10.20.[1.10].').modality).toBe('negated');
    expect(assess('Not e.g. the cache or [the proxy].').modality).toBe('negated');
  });

  it('keeps a denial over a short list and drops it after a few words', () => {
    expect(assess('No DNS, proxy or [CA issues] found.').modality).toBe('negated');
    expect(
      assess('Users are not able to sign in at all and then they start to fail [intermittently].')
        .modality,
    ).toBe('asserted');
  });

  it('does not let a conditional reach past its comma', () => {
    expect(assess('If the cache is cleared, [the problem goes away].').modality).toBe('asserted');
    expect(assess('If [the problem goes away] we will close the case.').modality).toBe(
      'conditional',
    );
  });

  it('treats a polite "if possible" as no condition', () => {
    expect(assess('Please send the logs if possible and [the HAR capture].').modality).toBe(
      'requested',
    );
    expect(assess('If you can, [clear the cache].').cueId).not.toBe('condition');
  });

  it('keeps "not only", "no problem" and "do not forget" from reading as denials', () => {
    expect(assess('It is not only [the cache].').modality).toBe('asserted');
    expect(assess('No problem, we [checked the logs].').modality).toBe('asserted');
    expect(assess('Do not forget to [send the capture].').modality).toBe('requested');
  });
});

describe('a detector that looks for a denial', () => {
  const marked = 'Service health shows [no active incident] for Teams.';
  it('is not undone by the denial it matched', () => {
    expect(assess(marked).modality).toBe('negated');
    expect(assess(marked, { negativeContent: true }).modality).toBe('asserted');
  });

  it('is still undone by a denial before its match', () => {
    expect(
      assess('We could not confirm that [no incident is active].', { negativeContent: true })
        .modality,
    ).toBe('negated');
  });
});

describe('what each use lets fire', () => {
  it('lets a signal fire on a stated or reported fact and not on a denial, a plan, a guess or a condition', () => {
    for (const modality of ['asserted', 'attributed', 'corrected'] as const)
      expect(firesFor('signal', modality)).toBe(true);
    for (const modality of [
      'negated',
      'speculative',
      'future_intent',
      'conditional',
      'requested',
    ] as const)
      expect(firesFor('signal', modality)).toBe(false);
  });

  it('lets an engineer action fire only when it is stated as done', () => {
    expect(firesFor('action', 'asserted')).toBe(true);
    for (const modality of [
      'negated',
      'future_intent',
      'conditional',
      'speculative',
      'requested',
      'attributed',
    ] as const)
      expect(firesFor('action', modality)).toBe(false);
  });

  it('lets a step the customer takes count when the engineer asks for it or announces it', () => {
    for (const modality of ['asserted', 'requested', 'future_intent'] as const)
      expect(firesFor('delegated_action', modality)).toBe(true);
    for (const modality of ['negated', 'conditional', 'speculative', 'attributed'] as const)
      expect(firesFor('delegated_action', modality)).toBe(false);
  });
});

describe('quoted history', () => {
  const reply = [
    'Thanks, the reply is below.',
    'Sign-ins still fail for 40 people.',
    '',
    'On Tue, 2 Jun 2026 at 09:10, Support Engineer <support@example.test> wrote:',
    '> Do the failures come and go?',
    '> Please send three user names.',
  ].join('\n');

  it('blanks the quoted lines and what follows a reply marker, character for character', () => {
    const masked = maskQuotedHistory(reply, 'customer_email');
    expect(masked).toHaveLength(reply.length);
    expect(masked.split('\n')).toHaveLength(reply.split('\n').length);
    expect(masked).toContain('Sign-ins still fail for 40 people.');
    expect(masked).not.toContain('come and go');
    expect(masked).not.toContain('three user names');
  });

  it('blanks an original-message block and an inline ">" quote', () => {
    const text =
      'Fixed now.\n> was it DNS?\nThanks\n-----Original Message-----\nFrom: someone\nIt is intermittent';
    const masked = maskQuotedHistory(text, 'engineer_email');
    expect(masked).toContain('Fixed now.');
    expect(masked).toContain('Thanks');
    expect(masked).not.toContain('intermittent');
    expect(masked).not.toContain('DNS');
  });

  it('leaves tool output and text without a quote exactly as it is', () => {
    const output = '> nslookup login.microsoftonline.com\nServer: 10.20.1.10';
    expect(maskQuotedHistory(output, 'diagnostic_result')).toBe(output);
    expect(maskQuotedHistory('No quotes here. Users fail.', 'customer_email')).toBe(
      'No quotes here. Users fail.',
    );
  });
});

describe('properties', () => {
  it('masking keeps the length and the line structure of any text', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 400 }),
        fc.constantFrom('customer_email', 'engineer_email', 'case_note'),
        (text, type) => {
          const masked = maskQuotedHistory(text, type);
          expect(masked).toHaveLength(text.length);
          expect([...masked].filter((c) => c === '\n').length).toBe(
            [...text].filter((c) => c === '\n').length,
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it('always answers with a known modality and never throws, wherever the span is', () => {
    const known = new Set([
      'asserted',
      'negated',
      'speculative',
      'future_intent',
      'conditional',
      'attributed',
      'requested',
      'corrected',
    ]);
    fc.assert(
      fc.property(
        fc.string({ maxLength: 600 }),
        fc.nat(600),
        fc.nat(60),
        fc.boolean(),
        (text, from, length, negativeContent) => {
          const start = Math.min(from, text.length);
          const end = Math.min(text.length, start + length);
          expect(known.has(assessModality(text, start, end, { negativeContent }).modality)).toBe(
            true,
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  it('a span with no cue words before it is asserted', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('proxy', 'dns', 'users', 'sign', 'in', 'fail', 'teams', 'logs'), {
          maxLength: 30,
        }),
        (words) => {
          const text = words.join(' ');
          expect(assessModality(text, text.length, text.length)).toEqual(ASSERTED);
        },
      ),
    );
  });

  it('stays fast on text built to be slow', () => {
    const hostile = `${'not no never '.repeat(1500)}logs ${'. '.repeat(500)}${'if '.repeat(1500)}checked`;
    const started = process.hrtime.bigint();
    for (let i = 0; i < 20; i += 1) assessModality(hostile, hostile.length - 7, hostile.length);
    const letters = 'a'.repeat(20_000);
    for (let i = 0; i < 5; i += 1) assessModality(letters, 0, letters.length);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    expect(ms).toBeLessThan(1500);
  });
});
