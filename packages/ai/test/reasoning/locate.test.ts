import { describe, expect, it } from 'vitest';
import { verifyExcerpt } from '@caseguard/domain';
import { findInOriginal, locateCitation } from '../../src/reasoning/locate';
import type { RuleEvent } from '../../src/reasoning/context';
import { normaliseExcerpt } from '../../src/reasoning/text';
import { sha256Hex } from '../../src/util/hash';

const event = (over: Partial<RuleEvent> = {}): RuleEvent => ({
  id: 'e1',
  at: '2026-03-09T09:00:00.000Z',
  sequence: 0,
  shownTitle: 'Sign-in failing',
  shownText: 'Users cannot sign in.  The error code is   caa82ee7 and the page never loads.',
  storedTitle: 'Sign-in failing',
  storedBody: 'Users cannot sign in.  The error code is   caa82ee7 and the page never loads.',
  ...over,
});

describe('normalising a quotation', () => {
  it('collapses whitespace runs, trims and composes Unicode, and nothing else', () => {
    expect(normaliseExcerpt('  a \n\t b  ')).toBe('a b');
    expect(normaliseExcerpt('Cafe\u0301')).toBe('Caf\u00e9');
    expect(normaliseExcerpt('A\u00a0B')).toBe('A B');
    expect(normaliseExcerpt('Case Matters')).toBe('Case Matters');
    expect(normaliseExcerpt('a\u200bb')).toBe('a\u200bb');
  });
});

describe('finding a quotation in the stored text', () => {
  it('returns offsets into the original, whatever whitespace the original holds', () => {
    const body = 'Users cannot sign in.  The error code is   caa82ee7 and the page never loads.';
    const hit = findInOriginal(body, 'The error code is caa82ee7');
    expect(hit).not.toBeNull();
    expect(body.slice(hit?.start, hit?.end)).toBe('The error code is   caa82ee7');
  });

  it('finds the first occurrence', () => {
    const hit = findInOriginal('one two one two', 'one two');
    expect(hit).toEqual({ start: 0, end: 7 });
  });

  it('finds nothing that is not there, and nothing for an empty quotation', () => {
    expect(findInOriginal('abc def', 'xyz')).toBeNull();
    expect(findInOriginal('abc def', '')).toBeNull();
  });

  it('works on a text with leading and trailing whitespace', () => {
    const hit = findInOriginal('\n  hello   world  \n', 'hello world');
    expect('\n  hello   world  \n'.slice(hit?.start, hit?.end)).toBe('hello   world');
  });

  it('maps a decomposed original to its own offsets', () => {
    const original = 'Cafe\u0301 au lait is on the menu.';
    const hit = findInOriginal(original, 'Caf\u00e9 au lait');
    expect(hit).not.toBeNull();
    expect(original.slice(hit?.start, hit?.end)).toBe('Cafe\u0301 au lait');
  });

  it('handles characters outside the basic plane', () => {
    const original = 'Status \u{1f600} ok  \u{1f680} launched';
    const hit = findInOriginal(original, '\u{1f680} launched');
    expect(original.slice(hit?.start, hit?.end)).toBe('\u{1f680} launched');
  });
});

describe('locating a citation', () => {
  it('records the span, the field and the hash of the stored text, and the domain verifies it', () => {
    const e = event();
    const located = locateCitation(e, { eventId: 'e1', excerpt: 'The error code is caa82ee7' });
    expect(located).toMatchObject({
      eventId: 'e1',
      verifiedIn: 'stored_text',
      field: 'body',
      verified: true,
      sourceHash: sha256Hex(e.storedBody),
    });
    expect(located?.excerpt).toBe('The error code is   caa82ee7');
    expect(e.storedBody.slice(located?.start ?? 0, located?.end ?? 0)).toBe(located?.excerpt);
    const check = verifyExcerpt(
      { id: 'e1', title: e.storedTitle, body: e.storedBody },
      {
        eventId: 'e1',
        field: located?.field ?? undefined,
        start: located?.start ?? undefined,
        end: located?.end ?? undefined,
        excerpt: located?.excerpt,
      },
    );
    expect(check.verification).toBe('verified');
  });

  it('finds a quotation in the title when the body does not hold it', () => {
    const located = locateCitation(event(), { eventId: 'e1', excerpt: 'Sign-in failing' });
    expect(located).toMatchObject({ field: 'title', verifiedIn: 'stored_text' });
    expect(located?.start).toBe(0);
    expect(located?.end).toBe('Sign-in failing'.length);
  });

  it('never trusts offsets: there are none to give, and the result depends on the text alone', () => {
    const located = locateCitation(event(), {
      eventId: 'e1',
      excerpt: 'the page never loads.',
      ...({ start: 3, end: 9 } as object),
    });
    expect(located?.start).toBe(event().storedBody.indexOf('the page never loads.'));
  });

  it('records a quotation of redacted text as verified in the redacted view, without offsets', () => {
    const e = event({
      shownText: 'The service uses [REDACTED:api_key_assignment] for calls.',
      storedBody: 'The service uses api_key=abcdef1234567890 for calls.',
    });
    const located = locateCitation(e, {
      eventId: 'e1',
      excerpt: 'uses [REDACTED:api_key_assignment] for calls',
    });
    expect(located).toMatchObject({
      verifiedIn: 'redacted_view',
      field: null,
      start: null,
      end: null,
      verified: true,
      excerpt: 'uses [REDACTED:api_key_assignment] for calls',
      sourceHash: sha256Hex(e.shownText ?? ''),
    });
  });

  it('prefers the stored text when both hold the quotation', () => {
    expect(
      locateCitation(event(), { eventId: 'e1', excerpt: 'Users cannot sign in.' })?.verifiedIn,
    ).toBe('stored_text');
  });

  it('gives nothing for a quotation that is in neither', () => {
    expect(
      locateCitation(event(), { eventId: 'e1', excerpt: 'The firewall dropped everything.' }),
    ).toBeNull();
    expect(locateCitation(event(), { eventId: 'e1', excerpt: 'ab' })).toBeNull();
  });

  it('cuts a span at 280 characters so the excerpt is exactly the stored span', () => {
    const long = `${'word '.repeat(80)}end`;
    const e = event({ storedBody: long, shownText: long });
    const located = locateCitation(e, { eventId: 'e1', excerpt: long.slice(0, 299) });
    expect(located?.excerpt.length).toBeLessThanOrEqual(280);
    expect(long.slice(located?.start ?? 0, located?.end ?? 0)).toBe(located?.excerpt);
  });

  it('does not cut a surrogate pair in two', () => {
    const body = `${'a'.repeat(279)}\u{1f600}${'b'.repeat(20)}`;
    const e = event({ storedBody: body, shownText: body });
    const located = locateCitation(e, { eventId: 'e1', excerpt: body.slice(0, 290) });
    const excerpt = located?.excerpt ?? '';
    expect(excerpt.endsWith('\ud83d')).toBe(false);
    expect(body.slice(located?.start ?? 0, located?.end ?? 0)).toBe(excerpt);
  });

  it('records the same location for the same text, however the model spaced it', () => {
    const a = locateCitation(event(), { eventId: 'e1', excerpt: 'The error code is caa82ee7' });
    const b = locateCitation(event(), {
      eventId: 'e1',
      excerpt: 'The  error\ncode   is caa82ee7 ',
    });
    expect(a).toEqual(b);
  });
});
