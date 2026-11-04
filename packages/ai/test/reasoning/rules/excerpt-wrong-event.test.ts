import { describe, expect, it } from 'vitest';
import { checkExcerptWrongEvent } from '../../../src/reasoning/rules/excerpt';
import { proposal, ruleContext } from '../fixtures';

const ctx = ruleContext();
const cite = (eventId: string, excerpt: string) =>
  proposal('signal', { evidence: [{ eventId, excerpt }] });
const verdicts = (raw: unknown) => checkExcerptWrongEvent(raw, ctx).map((i) => [i.code, i.path]);

describe('rule excerpt_wrong_event', () => {
  it('lets a quotation of the cited event through', () => {
    expect(verdicts(proposal('signal'))).toEqual([]);
    expect(verdicts(cite('e3', 'We did not capture a HAR file.'))).toEqual([]);
  });

  it('reports a real quotation cited for another event', () => {
    // "We did not capture a HAR file." is in e3, not in e2.
    expect(verdicts(cite('e2', 'We did not capture a HAR file.'))).toEqual([
      ['excerpt_wrong_event', 'evidence[0].excerpt'],
    ]);
    expect(
      verdicts(cite('e5', 'Revoked sign-in sessions for the 140 affected users')),
    ).toHaveLength(1);
  });

  it('is the case of a finding that looks valid but quotes the wrong event', () => {
    const lookalike = proposal('missing_evidence', {
      neededByEventId: 'e4',
      evidence: [{ eventId: 'e1', excerpt: 'We did not capture a HAR file.' }],
    });
    expect(verdicts(lookalike)).toEqual([['excerpt_wrong_event', 'evidence[0].excerpt']]);
  });

  it('does not report text that is nowhere, and leaves that to excerpt_not_found', () => {
    expect(verdicts(cite('e2', 'The firewall dropped the packets.'))).toEqual([]);
  });

  it('does not report a citation of an event the model was not shown', () => {
    expect(verdicts(cite('e99', 'We did not capture a HAR file.'))).toEqual([]);
  });

  it('finds the real source in the title of another event too', () => {
    expect(verdicts(cite('e1', 'Findings from sign-in logs'))).toHaveLength(1);
  });

  it('applies to every quotation of the proposal', () => {
    const raw = proposal('signal', {
      evidence: [
        { eventId: 'e3', excerpt: 'We did not capture a HAR file.' },
        { eventId: 'e1', excerpt: 'Likely a Conditional Access policy issue.' },
        { eventId: 'e5', excerpt: 'Revoked sign-in sessions for the 140 affected users' },
      ],
    });
    expect(verdicts(raw).map((v) => v[1])).toEqual(['evidence[1].excerpt', 'evidence[2].excerpt']);
  });
});
