import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { CaseEvent, SourceRef } from '@caseguard/schemas';
import {
  CONTEXT_CHARS_AFTER,
  CONTEXT_CHARS_BEFORE,
  CONTEXT_CHARS_MATCH,
  eventText,
  locateInEvent,
  matchDetector,
  sourcePointerFor,
  verifyExcerpt,
  type CompiledDetector,
} from '../src';
import { CASE_ONE, CASE_TWO, prepareBundle, prepareCase } from './helpers';
import { computeCase } from './engine-golden';
import { AWKWARD } from './source-linkage-fixtures';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** A stored event with only what the text checks read; the rest is filler that satisfies the type. */
function eventOf(title: string | null, body: string): CaseEvent {
  return {
    tenantId: 'tenant_test',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'test',
    version: 1,
    id: 'evt_1',
    caseId: 'case_1',
    sourceId: 'src_1',
    sequence: 0,
    timestamp: '2026-01-01T00:00:00.000Z',
    participantId: 'p_1',
    participantRole: 'customer_end_user',
    participantAlias: 'End User 1',
    type: 'customer_email',
    channel: 'email',
    title,
    body,
    action: null,
    inResponseTo: null,
    correlationIds: [],
    structured: null,
    ai: null,
    sourcePointer: '/events/0',
    redaction: { redacted: false, categories: [] },
    immutable: true,
  };
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** What the engine itself records for the first occurrence of `needle` in an event. */
function engineRef(event: CaseEvent, needle: string): SourceRef | null {
  const compiled: CompiledDetector = {
    detector: { kind: 'regex', pattern: escapeRegex(needle), flags: '' },
    regex: new RegExp(escapeRegex(needle)),
  };
  const match = matchDetector(compiled, event);
  if (match === null || match.start === null || match.end === null) return null;
  const located = locateInEvent(event, match.start, match.end);
  return {
    eventId: event.id,
    sourceId: event.sourceId,
    pointer: sourcePointerFor(event, located.field),
    ...located,
    excerpt: match.excerpt.slice(0, 280),
  };
}

const fieldOf = (event: CaseEvent, field: 'title' | 'body' | 'titleAndBody'): string =>
  field === 'title'
    ? (event.title ?? '')
    : field === 'body'
      ? event.body
      : `${event.title ?? ''}\n${event.body}`;

/** A piece of the scanned text of up to `max` whole characters, so it never splits an emoji. */
function needleOf(event: CaseEvent, a: number, b: number, max: number): string {
  const chars = Array.from(eventText(event));
  const start = a % chars.length;
  return chars.slice(start, start + 1 + (b % Math.min(max, chars.length - start))).join('');
}

const ALPHABET = ['a', 'b', 'c', 'x', ' ', ' ', '\n', '.', '-', '…', '😀', 'é', '\t'];
const textArb = fc
  .array(fc.constantFrom(...ALPHABET), { minLength: 1, maxLength: 400 })
  .map((chars) => chars.join(''));
const optionalTitleArb = fc.option(textArb, { nil: null });

describe('locateInEvent: an offset is tied to the text it counts into', () => {
  const event = eventOf('Sign-in fails', 'Users in Pune cannot sign in.');
  const scan = eventText(event);

  it('keeps a span in the title, moves a span in the body, and names a span across both', () => {
    const inTitle = scan.indexOf('fails');
    expect(locateInEvent(event, inTitle, inTitle + 5)).toEqual({
      field: 'title',
      start: inTitle,
      end: inTitle + 5,
    });
    const inBody = scan.indexOf('Pune');
    expect(locateInEvent(event, inBody, inBody + 4)).toEqual({
      field: 'body',
      start: event.body.indexOf('Pune'),
      end: event.body.indexOf('Pune') + 4,
    });
    const across = scan.indexOf('fails\nUsers');
    expect(locateInEvent(event, across, across + 11)).toEqual({
      field: 'titleAndBody',
      start: across,
      end: across + 11,
    });
  });

  it('counts a span that ends at the end of the title as the title, and the line break as both', () => {
    expect(locateInEvent(event, 0, 13).field).toBe('title');
    expect(locateInEvent(event, 12, 14).field).toBe('titleAndBody');
    expect(locateInEvent(event, 13, 14).field).toBe('titleAndBody');
    expect(locateInEvent(event, 14, 15).field).toBe('body');
  });

  it('is the body with the same numbers when the event has no title', () => {
    expect(locateInEvent(eventOf(null, 'abc'), 1, 2)).toEqual({ field: 'body', start: 1, end: 2 });
    expect(locateInEvent(eventOf('', 'abc'), 1, 2)).toEqual({ field: 'body', start: 1, end: 2 });
  });

  it('names the same characters whichever field a span is counted into (property)', () => {
    fc.assert(
      fc.property(optionalTitleArb, textArb, fc.nat(), fc.nat(), (title, body, a, b) => {
        const e = eventOf(title, body);
        const text = eventText(e);
        const start = a % text.length;
        const end = start + 1 + (b % (text.length - start));
        const located = locateInEvent(e, start, end);
        expect(fieldOf(e, located.field).slice(located.start, located.end)).toBe(
          text.slice(start, end),
        );
      }),
      { numRuns: 400 },
    );
  });
});

describe('verifyExcerpt: what the engine records is what the check accepts', () => {
  it('verifies every text excerpt of both samples, and never claims anything for the rest', () => {
    for (const file of [CASE_ONE, CASE_TWO]) {
      const prepared = prepareCase(file);
      const { analysis } = computeCase(prepared);
      const eventById = new Map(prepared.normalized.events.map((e) => [e.id, e]));
      let verified = 0;
      for (const item of [...analysis.evidence, ...analysis.claims]) {
        const event = item.eventId === null ? undefined : eventById.get(item.eventId);
        if (event === undefined || item.sourceRef === null) continue;
        const check = verifyExcerpt(event, item.sourceRef);
        expect(check.verification, `${item.id}: ${check.reason}`).not.toBe('mismatch');
        // A value found in the text has a field and is verified; a structured or derived one has none.
        expect(check.verification === 'verified', item.id).toBe(item.sourceRef.field !== undefined);
        if (check.verification === 'verified') verified += 1;
        else expect(check.context).toBeNull();
      }
      expect(verified).toBeGreaterThan(20);
    }
  });

  it('shows the quoted span and its surroundings straight from the stored text', () => {
    const event = eventOf(
      'Sign-in fails for Pune',
      'Hello,\n\nUsers in Pune cannot sign in to Teams.',
    );
    const ref = engineRef(event, 'cannot sign in');
    expect(ref).not.toBeNull();
    const check = verifyExcerpt(event, ref);
    expect(check.verification).toBe('verified');
    expect(check.context).toEqual({
      before: 'Hello,\n\nUsers in Pune ',
      match: 'cannot sign in',
      after: ' to Teams.',
    });
  });

  it('verifies a span that crosses the line break between the title and the body', () => {
    const event = eventOf('Output of dsregcmd: AzureAdPrt', ': YES on the laptop');
    const ref = engineRef(event, 'AzureAdPrt\n:');
    expect(ref?.field).toBe('titleAndBody');
    expect(ref?.pointer).toBe('/events/0');
    const check = verifyExcerpt(event, ref);
    expect(check.verification).toBe('verified');
    expect(check.context?.match).toBe('AzureAdPrt\n:');
  });

  it('verifies the span form of statement and attribute claims, offsets counted from the body', () => {
    const event = eventOf('Re: sign-in', 'First sentence.   Indented claim here. Last one.');
    const start = event.body.indexOf('Indented');
    const text = 'Indented claim here.';
    const ref: SourceRef = {
      eventId: event.id,
      field: 'body',
      start,
      end: start + text.length,
      excerpt: text,
    };
    expect(verifyExcerpt(event, ref).verification).toBe('verified');
    expect(
      verifyExcerpt(event, { ...ref, start: start - 1, end: start - 1 + text.length }),
    ).toMatchObject({ verification: 'mismatch', reason: 'text_differs' });
  });

  it('accepts an excerpt the engine cut to its maximum length', () => {
    const long = eventOf(null, 'a'.repeat(300));
    const longRef = engineRef(long, 'a'.repeat(290));
    expect(longRef?.excerpt?.length).toBe(280);
    expect(verifyExcerpt(long, longRef).verification).toBe('verified');
    const wide = eventOf(
      'A title',
      `${'word '.repeat(60)}${'needle '.repeat(50)}${'word '.repeat(60)}`,
    );
    const wideRef = engineRef(wide, 'needle '.repeat(50));
    expect(wideRef?.excerpt?.length).toBe(280);
    expect(verifyExcerpt(wide, wideRef).verification).toBe('verified');
  });

  it('reproduces the rule that stops reading an event at 20,000 characters', () => {
    const body = `${'x'.repeat(19_990)} needle here`;
    const event = eventOf(null, body);
    const ref = engineRef(event, 'needle');
    expect(ref?.start).toBe(19_991);
    expect(verifyExcerpt(event, ref).verification).toBe('verified');
  });

  it('verifies any excerpt the engine records, in whichever field it falls (property)', () => {
    fc.assert(
      fc.property(optionalTitleArb, textArb, fc.nat(), fc.nat(), (title, body, a, b) => {
        const event = eventOf(title, body);
        const needle = needleOf(event, a, b, 40);
        fc.pre(needle.trim().length > 0);
        const ref = engineRef(event, needle);
        fc.pre(ref !== null);
        const check = verifyExcerpt(event, ref);
        expect(check.reason).toBe('matches');
        const field = fieldOf(event, ref?.field ?? 'body');
        expect(check.context?.match).toBe(field.slice(ref?.start, ref?.end));
      }),
      { numRuns: 500 },
    );
  });
});

describe('verifyExcerpt: negative controls', () => {
  const event = eventOf(
    'Teams sign-in failing intermittently',
    'Hello,\n\nSince about 08:50 UTC roughly 140 users across our Pune and Leeds offices cannot sign in. A retry sometimes works.',
  );
  const good = engineRef(event, '140 users') as SourceRef;

  it('the control itself is verified', () => {
    expect(good.field).toBe('body');
    expect(verifyExcerpt(event, good).verification).toBe('verified');
  });

  it('a tampered excerpt is a mismatch', () => {
    for (const excerpt of [
      good.excerpt?.replace('140', '141') ?? '',
      `${good.excerpt}!`,
      good.excerpt?.slice(1) ?? '',
      'something the stored message never said',
      '',
    ]) {
      expect(verifyExcerpt(event, { ...good, excerpt })).toMatchObject({
        verification: 'mismatch',
        reason: 'text_differs',
        context: null,
      });
    }
  });

  it('offsets that point elsewhere are a mismatch, never a verified quotation', () => {
    for (const shift of [-20, -1, 1, 7, 30]) {
      const moved = { ...good, start: (good.start ?? 0) + shift, end: (good.end ?? 0) + shift };
      expect(verifyExcerpt(event, moved).verification, `shift ${shift}`).toBe('mismatch');
    }
    expect(verifyExcerpt(event, { ...good, start: 5, end: 3 })).toMatchObject({
      verification: 'mismatch',
      reason: 'out_of_range',
    });
    expect(verifyExcerpt(event, { ...good, end: event.body.length + 50 })).toMatchObject({
      verification: 'mismatch',
      reason: 'out_of_range',
    });
  });

  it('offsets counted into the wrong field are a mismatch', () => {
    expect(verifyExcerpt(event, { ...good, field: 'title' }).verification).toBe('mismatch');
    expect(verifyExcerpt(event, { ...good, field: 'titleAndBody' }).verification).toBe('mismatch');
    const titled = engineRef(event, 'intermittently') as SourceRef;
    expect(titled.field).toBe('title');
    expect(verifyExcerpt(event, titled).verification).toBe('verified');
    expect(verifyExcerpt(event, { ...titled, field: 'body' }).verification).toBe('mismatch');
    // A title that is not there cannot hold anything.
    expect(verifyExcerpt(eventOf(null, event.body), { ...good, field: 'title' })).toMatchObject({
      verification: 'mismatch',
      reason: 'out_of_range',
    });
  });

  it('text that was edited after the analysis is a mismatch', () => {
    const edited = eventOf(event.title, event.body.replace('140 users', '150 users'));
    expect(verifyExcerpt(edited, good).verification).toBe('mismatch');
  });

  it('body offsets do not depend on the title, but an excerpt that reached into the title does', () => {
    const body = `${'filler text. '.repeat(10)}the customer reports 140 users affected. ${'more text. '.repeat(10)}`;
    const far = engineRef(eventOf('Original title', body), '140 users') as SourceRef;
    expect(far.field).toBe('body');
    expect(verifyExcerpt(eventOf('Original title', body), far).verification).toBe('verified');
    expect(
      verifyExcerpt(eventOf('A completely different and much longer title', body), far)
        .verification,
    ).toBe('verified');
    const near = engineRef(
      eventOf('Short title', 'Hello 140 users here'),
      '140 users',
    ) as SourceRef;
    expect(near.excerpt).toContain('Short title');
    expect(verifyExcerpt(eventOf('Another title', 'Hello 140 users here'), near).verification).toBe(
      'mismatch',
    );
  });

  it('a reference to another event is a mismatch', () => {
    expect(verifyExcerpt(event, { ...good, eventId: 'evt_other' })).toMatchObject({
      verification: 'mismatch',
      reason: 'wrong_event',
    });
  });

  it('changing any character the quotation covers is a mismatch (property)', () => {
    fc.assert(
      fc.property(
        optionalTitleArb,
        textArb,
        fc.nat(),
        fc.nat(),
        fc.nat(),
        (title, body, a, b, c) => {
          const original = eventOf(title, body);
          const needle = needleOf(original, a, b, 30);
          fc.pre(needle.trim().length > 0);
          const ref = engineRef(original, needle);
          fc.pre(ref !== null && ref.start !== undefined && ref.end !== undefined);
          const field = fieldOf(original, ref?.field ?? 'body');
          const covered = [...Array(ref?.end ?? 0).keys()].filter(
            (i) => i >= (ref?.start ?? 0) && !/[\s\uD800-\uDFFF]/u.test(field[i] ?? ' '),
          );
          fc.pre(covered.length > 0);
          const at = covered[c % covered.length] ?? 0;
          const changed = `${field.slice(0, at)}#${field.slice(at + 1)}`;
          const edited =
            ref?.field === 'title'
              ? eventOf(changed, body)
              : ref?.field === 'body'
                ? eventOf(title, changed)
                : eventOf(
                    changed.slice(0, (title ?? '').length),
                    changed.slice((title ?? '').length + 1),
                  );
          expect(verifyExcerpt(edited, ref).verification).toBe('mismatch');
        },
      ),
      { numRuns: 300 },
    );
  });

  it('never verifies a reference that lacks the field, the offsets or the excerpt (property)', () => {
    const refArb = fc.record(
      {
        eventId: fc.constant('evt_1'),
        field: fc.constantFrom('title', 'body', 'titleAndBody'),
        start: fc.nat({ max: 50 }),
        end: fc.nat({ max: 80 }),
        excerpt: textArb,
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(optionalTitleArb, textArb, refArb, (title, body, ref) => {
        const complete =
          ref.field !== undefined &&
          ref.start !== undefined &&
          ref.end !== undefined &&
          ref.excerpt !== undefined;
        fc.pre(!complete);
        const check = verifyExcerpt(eventOf(title, body), ref);
        expect(check.verification).toBe('not_checkable');
        expect(check.context).toBeNull();
      }),
      { numRuns: 300 },
    );
  });
});

describe('verifyExcerpt: awkward places in the text', () => {
  const { analysis, normalized } = prepareBundle(AWKWARD, 'case_awkward');

  it('verifies a match across the line break between the title and the body', () => {
    const crossing = analysis.evidence.find((e) => e.sourceRef.field === 'titleAndBody');
    const event = normalized.events.find((e) => e.id === 'a01');
    expect(crossing).toBeDefined();
    const check = verifyExcerpt(event ?? eventOf(null, ''), crossing?.sourceRef);
    expect(check.verification).toBe('verified');
    expect(check.context?.match).toMatch(/^AzureAdPrt\n: YES/);
  });

  it('verifies statements that start after spaces and tabs, and quotes only the words', () => {
    const event = normalized.events.find((e) => e.id === 'a02');
    const statements = analysis.claims.filter(
      (c) => c.ruleId.startsWith('statement.') && c.eventId === 'a02',
    );
    expect(statements.length).toBeGreaterThanOrEqual(2);
    for (const claim of statements) {
      const check = verifyExcerpt(event ?? eventOf(null, ''), claim.sourceRef);
      expect(check.verification, claim.id).toBe('verified');
      expect(check.context?.match, claim.id).toBe(claim.text);
    }
  });
});

describe('verifyExcerpt: when there is nothing to compare', () => {
  const event = eventOf('Title', 'Some body text that matters.');

  it('says so instead of verifying', () => {
    expect(verifyExcerpt(event, null)).toMatchObject({
      verification: 'not_checkable',
      reason: 'no_location',
    });
    expect(verifyExcerpt(event, undefined).verification).toBe('not_checkable');
    // Made before offsets were tied to a field: the numbers are there, what they count into is not.
    expect(
      verifyExcerpt(event, { eventId: 'evt_1', start: 0, end: 4, excerpt: 'Some' }),
    ).toMatchObject({ verification: 'not_checkable', reason: 'no_location' });
    // A structured value or a derived statement: an excerpt with no place in the text.
    expect(verifyExcerpt(event, { eventId: 'evt_1', excerpt: 'error = "x"' }).verification).toBe(
      'not_checkable',
    );
    expect(
      verifyExcerpt(event, { eventId: 'evt_1', field: 'body', start: 0, end: 4 }),
    ).toMatchObject({ verification: 'not_checkable', reason: 'no_excerpt' });
    expect(
      verifyExcerpt(event, { eventId: 'evt_1', field: 'body', start: 3, end: 3, excerpt: '' }),
    ).toMatchObject({ verification: 'not_checkable', reason: 'empty_span' });
  });

  it('gives no context unless the excerpt was verified', () => {
    for (const ref of [
      null,
      { eventId: 'evt_1', excerpt: 'x' },
      { eventId: 'evt_1', field: 'body' as const, start: 0, end: 4, excerpt: 'Nope' },
    ]) {
      expect(verifyExcerpt(event, ref).context).toBeNull();
    }
  });
});

describe('verifyExcerpt: the quotation it returns is bounded and verbatim', () => {
  it('is one contiguous piece of the stored text within the documented bounds (property)', () => {
    fc.assert(
      fc.property(optionalTitleArb, textArb, fc.nat(), fc.nat(), (title, body, a, b) => {
        const event = eventOf(title, body);
        const needle = needleOf(event, a, b, 60);
        fc.pre(needle.trim().length > 0);
        const ref = engineRef(event, needle);
        fc.pre(ref !== null);
        const { context } = verifyExcerpt(event, ref);
        expect(context).not.toBeNull();
        if (context === null || ref === null) return;
        const field = fieldOf(event, ref.field ?? 'body');
        const at = ref.start ?? 0;
        const after = at + context.match.length;
        expect(context.before.length).toBeLessThanOrEqual(CONTEXT_CHARS_BEFORE);
        expect(context.after.length).toBeLessThanOrEqual(CONTEXT_CHARS_AFTER);
        expect(context.match.length).toBeLessThanOrEqual(CONTEXT_CHARS_MATCH);
        expect(field.slice(at - context.before.length, at)).toBe(context.before);
        expect(field.slice(at, after)).toBe(context.match);
        expect(field.slice(after, after + context.after.length)).toBe(context.after);
        // The stored text is well formed (no half of an emoji), and a quotation must not add one.
        for (const part of [context.before, context.match, context.after]) {
          expect(LONE_SURROGATE.test(part)).toBe(false);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('cuts a very long span and then shows nothing after it, so the quotation stays contiguous', () => {
    const span = 'long '.repeat(400).trim();
    const body = `before ${span} after`;
    const event = eventOf(null, body);
    const start = body.indexOf('long');
    const ref: SourceRef = {
      eventId: event.id,
      field: 'body',
      start,
      end: start + span.length,
      excerpt: span.slice(0, 280),
    };
    const { context, verification } = verifyExcerpt(event, ref);
    expect(verification).toBe('verified');
    expect(context?.match.length).toBeLessThanOrEqual(CONTEXT_CHARS_MATCH);
    expect(context?.after).toBe('');
    expect(span.startsWith(context?.match ?? '!')).toBe(true);
  });

  it('starts and stops at a word when it can, never inside one', () => {
    const word = 'abcdefghij ';
    const body = `${word.repeat(40)}needle ${word.repeat(40)}`;
    const event = eventOf(null, body);
    const { context } = verifyExcerpt(event, engineRef(event, 'needle'));
    expect(context?.before.startsWith('abcdefghij ')).toBe(true);
    expect(context?.before.length).toBeLessThanOrEqual(CONTEXT_CHARS_BEFORE);
    expect(context?.after.endsWith('abcdefghij')).toBe(true);
    expect(context?.after.length).toBeLessThanOrEqual(CONTEXT_CHARS_AFTER);
  });

  it('never starts or stops inside an emoji', () => {
    const event = eventOf(null, `${'😀'.repeat(300)} needle ${'😀'.repeat(300)}`);
    const { context } = verifyExcerpt(event, engineRef(event, 'needle'));
    expect(context).not.toBeNull();
    expect(LONE_SURROGATE.test(`${context?.before}${context?.after}`)).toBe(false);
    expect(context?.before.length).toBeGreaterThan(150);
  });
});
