import type { EvidenceLink } from '@caseguard/schemas';
import { PROVENANCE_MAX_LINKS } from '@caseguard/schemas';
import { describe, expect, it } from 'vitest';
import { linkKey, parseLinkKey, provenanceRequest, uniqueLinks, LINK_TYPE_WORDS } from './links';
import { clipWords, describeRange, describeSpan, joinWords, plural } from './words';

describe('[REV-WORDS-01] time in words', () => {
  it('names the two most significant units', () => {
    expect(describeSpan(0.2)).toBe('under a minute');
    expect(describeSpan(1)).toBe('1 minute');
    expect(describeSpan(45)).toBe('45 minutes');
    expect(describeSpan(90)).toBe('1 hour 30 minutes');
    expect(describeSpan(120)).toBe('2 hours');
    expect(describeSpan(910)).toBe('15 hours 10 minutes');
    expect(describeSpan(2 * 1440 + 3 * 60)).toBe('2 days 3 hours');
    expect(describeSpan(2 * 1440)).toBe('2 days');
    expect(describeSpan(1440 + 7)).toBe('1 day');
  });

  it('measures a negative span and refuses to print nonsense', () => {
    expect(describeSpan(-90)).toBe('1 hour 30 minutes');
    expect(describeSpan(Number.NaN)).toBe('an unknown time');
  });

  it('counts, joins and shortens without cutting a word', () => {
    expect(plural(1, 'event')).toBe('1 event');
    expect(plural(2, 'decision point')).toBe('2 decision points');
    expect(plural(2, 'hypothesis', 'hypotheses')).toBe('2 hypotheses');
    expect(joinWords([])).toBe('');
    expect(joinWords(['a'])).toBe('a');
    expect(joinWords(['a', 'b'])).toBe('a and b');
    expect(joinWords(['a', 'b', 'c'])).toBe('a, b and c');
    expect(clipWords('A short sentence.', 40)).toBe('A short sentence.');
    const clipped = clipWords(
      'The customer waited a very long time for a reply to the question.',
      30,
    );
    expect(clipped.length).toBeLessThanOrEqual(30);
    expect(clipped.endsWith('…')).toBe(true);
    expect(clipped).toBe('The customer waited a very…');
  });

  it('shows a range as its middle with the extremes, and a single value alone', () => {
    const minutes = (value: number): string => `${value} min`;
    expect(describeRange({ low: 84, mid: 84, high: 84 }, minutes)).toBe('84 min');
    expect(describeRange({ low: 69, mid: 100, high: 143 }, minutes)).toBe(
      '100 min (69 min to 143 min)',
    );
  });
});

describe('[REV-LINK-01] evidence links', () => {
  const link = (type: EvidenceLink['type'], id: string, label?: string): EvidenceLink => ({
    type,
    id,
    ...(label ? { label } : {}),
  });

  it('round-trips a link through its key and rejects what is not one', () => {
    expect(linkKey(link('evidence', 'evd_1'))).toBe('evidence:evd_1');
    expect(parseLinkKey('requirement:req.server-side-correlation')).toEqual({
      type: 'requirement',
      id: 'req.server-side-correlation',
    });
    for (const bad of [
      null,
      undefined,
      '',
      'evidence',
      ':id',
      'bogus:1',
      'event:a,b',
      'event:a b',
      // Names every object has: a type is one of the eight kinds, not whatever the prototype holds.
      'constructor:1',
      'toString:1',
      '__proto__:1',
    ])
      expect(parseLinkKey(bad), String(bad)).toBeNull();
    expect(parseLinkKey(`event:${'x'.repeat(121)}`)).toBeNull();
  });

  it('names every kind of link in plain words, never in the engine’s', () => {
    for (const word of Object.values(LINK_TYPE_WORDS))
      expect(word).not.toMatch(/fork|hypothesis|claim|scenario|requirement/i);
  });

  it('drops repeats and lets a later label fill in an earlier one that had none', () => {
    const merged = uniqueLinks([
      link('event', 'e1'),
      link('evidence', 'evd_1', 'Client reports a failure'),
      link('event', 'e1', 'Initial triage'),
      link('evidence', 'evd_1'),
    ]);
    expect(merged).toEqual([
      link('event', 'e1', 'Initial triage'),
      link('evidence', 'evd_1', 'Client reports a failure'),
    ]);
  });

  it('builds the provenance query, keeps what cannot be asked and never exceeds the limit', () => {
    const request = provenanceRequest([
      link('event', 'e07'),
      link('event', 'e07'),
      link('claim', 'clm,odd'),
      link('evidence', 'evd_1'),
    ]);
    expect(request.links).toBe('event:e07,evidence:evd_1');
    expect(request.asked.map(linkKey)).toEqual(['event:e07', 'evidence:evd_1']);
    expect(request.left.map(linkKey)).toEqual(['claim:clm,odd']);

    const many = Array.from({ length: PROVENANCE_MAX_LINKS + 5 }, (_, i) => link('event', `e${i}`));
    const capped = provenanceRequest(many);
    expect(capped.asked).toHaveLength(PROVENANCE_MAX_LINKS);
    expect(capped.left).toHaveLength(5);
    expect(provenanceRequest([]).links).toBeNull();
  });
});
