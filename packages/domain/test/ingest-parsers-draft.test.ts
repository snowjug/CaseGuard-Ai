import { describe, expect, it } from 'vitest';
import {
  parseCsvEvents,
  parsePastedTranscript,
  type IngestDraftOptions,
} from '../src/ingest/parsers';
import { computeConfidence } from '../src/ingest/parsers/confidence';
import { BASE, codes, expectFailure, expectOk, expectValidDraft } from './ingest-parsers.helpers';

const parse = (text: string, extra: Partial<IngestDraftOptions> = {}) =>
  parsePastedTranscript(text, { ...BASE, ...extra });
const stamp = (minute: number) => `[2026-03-09 09:${String(minute).padStart(2, '0')} UTC]`;

describe('draft assembly: participants and ids', () => {
  it('[FR-ING-01] treats two addresses behind one generic label as two people', () => {
    const text = [
      'From: Support Engineer <a@support-synthetic.invalid>\nSent: 2026-03-09 09:00 UTC\nSubject: One\n\nHello,\nlooking.\nRegards',
      'From: Support Engineer <b@support-synthetic.invalid>\nSent: 2026-03-09 09:10 UTC\nSubject: Two\n\nHello,\nme too.\nRegards',
      'From: Engineer Anna <a@support-synthetic.invalid>\nSent: 2026-03-09 09:20 UTC\nSubject: Three\n\nHello,\nagain.\nRegards',
    ].join('\n\n');
    const draft = expectOk(parse(text));
    expect(draft.bundle.participants.map((p) => p.alias)).toEqual([
      'Support Engineer 1',
      'Support Engineer 2',
    ]);
    expect(draft.bundle.events.map((e) => e.participantId)).toEqual(['p-eng', 'p-eng-2', 'p-eng']);
  });

  it('[FR-ING-01] numbers aliases by first appearance in time, not in the text', () => {
    const text = [
      `${stamp(30)} Support Engineer (second): later`,
      `${stamp(0)} Customer: earlier`,
    ].join('\n');
    const draft = expectOk(parse(text));
    expect(draft.bundle.participants.map((p) => p.alias)).toEqual([
      'Customer IT Admin 1',
      'Support Engineer 1',
    ]);
  });

  it('[FR-ING-02] fails with a friendly error when injected ids collide', () => {
    const failure = expectFailure(
      parse(`${stamp(0)} Customer: a\n${stamp(1)} Support Engineer: b`, {
        ids: { eventId: () => 'same', participantId: (_role, n) => `p-${n}` },
      }),
    );
    const paths = failure.errors.map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['participants[1].id', 'events[1].id']));
    for (const error of failure.errors) {
      expect(error.message).toMatch(
        /^The draft case is not valid: Duplicate (event|participant) id/,
      );
      expect(error.hint).toContain('unique "id"');
    }
  });

  it('[FR-ING-02] refuses more distinct speakers than the participant limit', () => {
    const failure = expectFailure(
      parse(`${stamp(0)} Customer: a\n${stamp(1)} Support Engineer: b`, {
        limits: { maxParticipants: 1 },
      }),
    );
    expect(failure.errors[0]).toMatchObject({ code: 'draft_invalid', path: '(draft)' });
    expect(failure.errors[0]?.message).toContain('2 distinct speakers; the limit is 1');
  });
});

describe('draft assembly: messages and structure', () => {
  it('[FR-ING-01] skips messages with no text, and keeps one that has only a subject', () => {
    const text = [
      `${stamp(0)} Customer:`,
      `${stamp(1)} Support Engineer: Ran the query.`,
      'From: Contoso admin\nSent: 2026-03-09 09:05 UTC\nSubject: Only a subject\n',
    ].join('\n');
    const draft = expectOk(parse(text));
    expect(draft.bundle.events.map((e) => [e.title ?? null, e.body])).toEqual([
      [null, 'Ran the query.'],
      ['Only a subject', ''],
    ]);
    expect(draft.warnings.find((w) => w.code === 'empty_message_skipped')).toMatchObject({
      count: 1,
      severity: 'info',
    });
    expect(draft.stats.ignoredLines).toBe(1);
  });

  it('[FR-ING-01] folds timestamped lines without a speaker into the previous message and says so', () => {
    const text = [
      `${stamp(0)} Support Engineer: Collected the log:`,
      '2026-03-09 08:59:01 first entry',
      '2026-03-09 08:59:02 second entry',
    ].join('\n');
    const draft = expectOk(parse(text));
    expect(draft.bundle.events).toHaveLength(1);
    expect(draft.bundle.events[0]?.body).toContain('08:59:02 second entry');
    expect(draft.warnings.find((w) => w.code === 'lines_without_speaker')?.count).toBe(2);
  });

  it('[FR-ING-01] warns about a code fence that is never closed', () => {
    const draft = expectOk(parse(`${stamp(0)} Support Engineer: Output:\n\`\`\`\nline one`));
    expect(codes(draft)).toContain('unclosed_code_fence');
  });

  it('[FR-ING-01] links an escalation response to the escalation it answers', () => {
    const text = [
      `${stamp(0)} Support Engineer: Escalating to the identity team.`,
      `${stamp(30)} Identity Escalation Engineer: Reviewed the traces.`,
    ].join('\n');
    const draft = expectOk(parse(text));
    expect(draft.bundle.events.map((e) => e.type)).toEqual(['escalation', 'escalation_response']);
    expect(draft.bundle.events[1]?.inResponseTo).toBe('e01');
  });

  it('[FR-ING-01] reads status, product and workload from the preamble, with a clear refusal for bad values', () => {
    const text = [
      'Status: closed',
      'Product: Microsoft Teams',
      'Workload: not a valid workload!',
      'Severity: urgent',
      'Reference: ab',
      `${stamp(0)} Customer: Teams fails for 40 users.`,
    ].join('\n');
    const draft = expectOk(parse(text));
    expect(draft.bundle.case).toMatchObject({
      status: 'closed',
      product: 'Microsoft Teams',
      severity: 'C',
    });
    expect(draft.bundle.case.reference).toMatch(/^CG-DRAFT-/);
    expect(codes(draft)).toEqual(expect.arrayContaining(['preamble_ignored', 'header_ignored']));
    expect(draft.warnings.find((w) => w.code === 'preamble_ignored')?.count).toBe(2);
  });

  it('[FR-ING-02] reports an unusable header value as a friendly draft error, not a crash', () => {
    const failure = expectFailure(
      parse([`Product: ${'P'.repeat(150)}`, `${stamp(0)} Customer: hi`].join('\n')),
    );
    expect(failure.errors[0]).toMatchObject({ code: 'schema_too_big', path: 'case.product' });
    expect(failure.errors[0]?.message).toMatch(
      /^The draft case is not valid: "product" is too long/,
    );
    expect(failure.errors[0]?.hint).toContain('at most 100 characters');
  });

  it('[FR-ING-01] shortens a very long title and never lets astral characters pass as length', () => {
    const long = expectOk(parse(`${stamp(0)} Customer: hi`, { title: `${'T'.repeat(250)}` }));
    expect(long.bundle.case.title).toHaveLength(200);
    expect(long.bundle.case.title.endsWith('…')).toBe(true);
    expect(codes(long)).toContain('title_truncated');
    const astral = expectOk(
      parse(`${stamp(0)} Customer: hi`, { title: '\u{1F600}\u{1F600}\u{1F600}' }),
    );
    expect(astral.bundle.case.title).toBe('Pasted case transcript');
    expect(codes(astral)).toContain('metadata_defaulted');
  });
});

describe('draft assembly: CSV specifics', () => {
  const csv = (text: string, extra: Record<string, unknown> = {}) =>
    parseCsvEvents(text, { ...BASE, workload: 'teams-authentication', ...extra });

  it('[FR-ING-01] drops a reply link that points at a later event', () => {
    const draft = expectOk(
      csv(
        'Id,Timestamp,Author,Text,In reply to\nA,2026-03-09T09:00:00Z,Support Engineer,q,B\nB,2026-03-09T10:00:00Z,Contoso admin,a,\n',
      ),
    );
    expect(draft.bundle.events.map((e) => e.inResponseTo)).toEqual([undefined, undefined]);
    expect(draft.warnings.find((w) => w.code === 'reply_link_dropped')).toMatchObject({ count: 1 });
  });

  it('[FR-ING-01] applies an assumed offset and reports unrecognised zones', () => {
    const draft = expectOk(
      csv(
        'Timestamp,Author,Text\n2026-03-09 09:00,Contoso admin,a\n2026-03-09 10:00 CST,Contoso admin,b\n',
        {
          assumedUtcOffsetMinutes: -300,
        },
      ),
    );
    expect(draft.bundle.events.map((e) => e.timestamp)).toEqual([
      '2026-03-09T14:00:00Z',
      '2026-03-09T15:00:00Z',
    ]);
    expect(codes(draft)).toEqual(
      expect.arrayContaining(['timezone_assumed', 'timezone_unrecognised']),
    );
    expect(draft.warnings.find((w) => w.code === 'timezone_assumed')?.message).toContain(
      'UTC-05:00',
    );
  });

  it('[FR-ING-01] lets the data itself decide the day/month order of slash dates', () => {
    const draft = expectOk(
      csv(
        'Timestamp,Author,Text\n03/09/2026 10:00 UTC,Contoso admin,ambiguous alone\n13/09/2026 10:00 UTC,Contoso admin,day first\n',
      ),
    );
    expect(draft.bundle.events.map((e) => e.timestamp)).toEqual([
      '2026-09-03T10:00:00Z',
      '2026-09-13T10:00:00Z',
    ]);
    const refused = expectFailure(
      csv('Timestamp,Author,Text\n03/09/2026 10:00 UTC,Contoso admin,x\n'),
    );
    expect(refused.errors[0]?.hint).toContain('dateOrder');
  });

  it('[FR-ING-01] reads the role from the Role column even when the name says nothing', () => {
    const draft = expectOk(
      csv('Timestamp,Author,Role,Text\n2026-03-09T09:00:00Z,Anna Schmidt,Support engineer,hello\n'),
    );
    expect(draft.bundle.participants[0]).toMatchObject({
      role: 'support_engineer',
      alias: 'Support Engineer 1',
    });
    expectValidDraft(draft.bundle);
  });
});

describe('parse confidence', () => {
  const clean = {
    eventCount: 10,
    unwrittenTimestamps: 0,
    assumedZoneEvents: 0,
    unidentifiedEvents: 0,
    defaultedTypeEvents: 0,
    ignoredLines: 0,
    nonBlankLines: 40,
    reordered: false,
    truncatedBodies: 0,
    mergedSpeakers: false,
  };

  it('[FR-ING-03] is 1 and high when everything was stated, and always labelled an estimate', () => {
    expect(computeConfidence(clean)).toMatchObject({ score: 1, level: 'high', estimated: true });
  });

  it('[FR-ING-03] drops by a documented amount per kind of inference and explains each', () => {
    const result = computeConfidence({
      ...clean,
      unwrittenTimestamps: 10,
      unidentifiedEvents: 10,
      defaultedTypeEvents: 10,
      ignoredLines: 40,
      assumedZoneEvents: 10,
      reordered: true,
      truncatedBodies: 1,
      mergedSpeakers: true,
    });
    expect(result.score).toBe(0.05);
    expect(result.level).toBe('low');
    expect(result.reasons).toHaveLength(8);
    const one = computeConfidence({ ...clean, unidentifiedEvents: 5 });
    expect(one.score).toBeCloseTo(0.83, 2);
    expect(one.reasons[0]).toContain(
      '5 of 10 events are from speakers whose role could not be told',
    );
  });

  it('[FR-ING-03] reaches medium and low for realistic problems', () => {
    expect(computeConfidence({ ...clean, unidentifiedEvents: 10 }).level).toBe('medium');
    const messy = expectOk(
      parse(
        ['Anna: hi', `${stamp(0)} Bob: hello`, 'Carol: ok', `${stamp(5)} Dave: sure`].join('\n'),
      ),
    );
    expect(messy.confidence.level).not.toBe('high');
    expect(messy.confidence.reasons.length).toBeGreaterThan(0);
  });
});
