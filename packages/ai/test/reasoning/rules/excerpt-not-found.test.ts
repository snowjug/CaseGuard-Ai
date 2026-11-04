import { describe, expect, it } from 'vitest';
import { checkExcerptNotFound } from '../../../src/reasoning/rules/excerpt';
import { proposal, ruleContext, ruleEvents } from '../fixtures';

const ctx = ruleContext();
const cite = (eventId: string, excerpt: string) =>
  proposal('signal', { evidence: [{ eventId, excerpt }] });
const verdicts = (raw: unknown, c = ctx) =>
  checkExcerptNotFound(raw, c).map((i) => [i.code, i.path]);

describe('rule excerpt_not_found', () => {
  it('lets a verbatim quotation of the cited event through, whole or in part', () => {
    expect(verdicts(proposal('signal'))).toEqual([]);
    expect(verdicts(cite('e3', 'We did not capture a HAR file.'))).toEqual([]);
    expect(verdicts(cite('e3', 'AADSTS50076'))).toEqual([]);
  });

  it('accepts a quotation from the title as well as from the body', () => {
    expect(verdicts(cite('e3', 'Findings from sign-in logs'))).toEqual([]);
  });

  it('reports a paraphrase, a changed word and an invented sentence', () => {
    for (const excerpt of [
      'The logs reveal AADSTS50076 for three users.',
      'We did not capture a HAR trace.',
      'The resolver is broken and nobody noticed.',
    ]) {
      expect(verdicts(cite('e3', excerpt))).toEqual([['excerpt_not_found', 'evidence[0].excerpt']]);
    }
  });

  it('is case sensitive: verbatim means the same characters', () => {
    expect(verdicts(cite('e3', 'we did not capture a har file.'))).toEqual([
      ['excerpt_not_found', 'evidence[0].excerpt'],
    ]);
  });

  it('ignores whitespace runs on both sides and nothing else', () => {
    const spaced = ruleContext({
      events: new Map(
        ruleEvents().map((e) =>
          e.id === 'e3'
            ? [
                e.id,
                {
                  ...e,
                  shownText: 'The sign-in log\n   shows AADSTS50076\tfor the three sample users.',
                },
              ]
            : [e.id, e],
        ),
      ),
    });
    expect(
      verdicts(cite('e3', 'The sign-in log shows AADSTS50076 for the three sample users.'), spaced),
    ).toEqual([]);
    expect(verdicts(cite('e3', 'The sign-in   log \n shows AADSTS50076'), spaced)).toEqual([]);
    expect(verdicts(cite('e3', 'The sign-in logshows'), spaced)).toEqual([
      ['excerpt_not_found', 'evidence[0].excerpt'],
    ]);
  });

  it('ignores the Unicode form on both sides', () => {
    const composed = 'Caf\u00e9 au lait';
    const decomposed = 'Cafe\u0301 au lait';
    const withAccent = ruleContext({
      events: new Map(
        ruleEvents().map((e) =>
          e.id === 'e1' ? [e.id, { ...e, shownText: decomposed }] : [e.id, e],
        ),
      ),
    });
    expect(verdicts(cite('e1', composed), withAccent)).toEqual([]);
    expect(verdicts(cite('e1', decomposed), withAccent)).toEqual([]);
  });

  it('refuses text past what the model was shown (the body was clipped)', () => {
    const clipped = ruleContext({
      events: new Map(
        ruleEvents().map((e) =>
          e.id === 'e3'
            ? [e.id, { ...e, shownText: 'The sign-in log shows AADSTS50076…' }]
            : [e.id, e],
        ),
      ),
    });
    expect(verdicts(cite('e3', 'We did not capture a HAR file.'), clipped)).toEqual([
      ['excerpt_not_found', 'evidence[0].excerpt'],
    ]);
  });

  it('refuses a quotation of an event whose text was not shown (header only, or a duplicate)', () => {
    const headerOnly = ruleContext({
      events: new Map(
        ruleEvents().map((e) => (e.id === 'e3' ? [e.id, { ...e, shownText: null }] : [e.id, e])),
      ),
    });
    expect(
      verdicts(cite('e3', 'We did not capture a HAR file.'), headerOnly).map((v) => v[0]),
    ).toEqual(['excerpt_not_found']);
  });

  it('refuses a quotation too short to mean anything', () => {
    expect(verdicts(cite('e3', 'we'))).toEqual([['excerpt_not_found', 'evidence[0].excerpt']]);
    expect(verdicts(cite('e3', '   a  '))).toEqual([['excerpt_not_found', 'evidence[0].excerpt']]);
  });

  it('finds every bad quotation of a proposal, in the key points of a synthesis too', () => {
    const raw = proposal('case_synthesis', {
      keyPoints: [
        {
          point: 'P1.',
          evidence: [{ eventId: 'e2', excerpt: 'Likely a Conditional Access policy issue.' }],
        },
        { point: 'P2.', evidence: [{ eventId: 'e2', excerpt: 'Certainly a firewall problem.' }] },
      ],
    });
    expect(verdicts(raw)).toEqual([['excerpt_not_found', 'keyPoints[1].evidence[0].excerpt']]);
  });

  it('leaves a citation of an event the model was not shown to unknown_event', () => {
    expect(verdicts(cite('e99', 'We did not capture a HAR file.'))).toEqual([]);
  });

  it('does not report a quotation of the wrong event here', () => {
    // The text is in e3; it is cited for e2.
    expect(verdicts(cite('e2', 'We did not capture a HAR file.'))).toEqual([]);
  });
});
