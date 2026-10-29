import { describe, expect, it } from 'vitest';
import type { ParticipantRole } from '@caseguard/schemas';
import { parsePastedTranscript, type IngestDraftOptions } from '../src/ingest/parsers';
import { inferRole, splitSpeakerLabel } from '../src/ingest/parsers/roles';
import { BASE, codes, expectFailure, expectOk, expectValidDraft } from './ingest-parsers.helpers';

const parse = (text: string, extra: Partial<IngestDraftOptions> = {}) =>
  parsePastedTranscript(text, { ...BASE, ...extra });

describe('parsePastedTranscript: timestamps', () => {
  const cases: {
    name: string;
    text: string;
    extra?: Partial<IngestDraftOptions>;
    expected: string;
    zoneAssumed: boolean;
  }[] = [
    {
      name: 'bracketed date and time',
      text: '[2026-03-09 09:12] Customer: Teams fails.',
      expected: '2026-03-09T09:12:00Z',
      zoneAssumed: true,
    },
    {
      name: 'ISO stamp with Z and dash separators',
      text: '2026-03-09T09:12:00Z - Engineer - Checked the logs.',
      expected: '2026-03-09T09:12:00Z',
      zoneAssumed: false,
    },
    {
      name: 'time of day with a default date',
      text: '09:12 Customer: Teams fails.',
      extra: { defaultDate: '2026-03-09' },
      expected: '2026-03-09T09:12:00Z',
      zoneAssumed: true,
    },
    {
      name: 'bracketed time with seconds',
      text: '[09:12:30] Support: Looking now.',
      extra: { defaultDate: '2026-03-09' },
      expected: '2026-03-09T09:12:30Z',
      zoneAssumed: true,
    },
    {
      name: 'parenthesised stamp with UTC',
      text: '(2026-03-09 09:12:30 UTC) Support Engineer: Looking now.',
      expected: '2026-03-09T09:12:30Z',
      zoneAssumed: false,
    },
    {
      name: 'numeric offset is honoured',
      text: '[2026-03-09 09:12 +02:00] Customer: hi',
      expected: '2026-03-09T07:12:00Z',
      zoneAssumed: false,
    },
    {
      name: 'UTC+2 style offset',
      text: '[2026-03-09 09:12 UTC+2] Customer: hi',
      expected: '2026-03-09T07:12:00Z',
      zoneAssumed: false,
    },
    {
      name: 'PM hours',
      text: '2026-03-09 9:12 PM Customer: hi',
      expected: '2026-03-09T21:12:00Z',
      zoneAssumed: true,
    },
    {
      name: '12 AM is midnight',
      text: '2026-03-09 12:05 AM UTC Customer: hi',
      expected: '2026-03-09T00:05:00Z',
      zoneAssumed: false,
    },
    {
      name: 'day-month-name date',
      text: '[9 March 2026 09:12 UTC] Customer: hi',
      expected: '2026-03-09T09:12:00Z',
      zoneAssumed: false,
    },
    {
      name: 'month-name-day date with weekday',
      text: '[Monday, March 9, 2026 9:12 AM UTC] Customer: hi',
      expected: '2026-03-09T09:12:00Z',
      zoneAssumed: false,
    },
    {
      name: 'European dotted date',
      text: '[09.03.2026 09:12 UTC] Customer: hi',
      expected: '2026-03-09T09:12:00Z',
      zoneAssumed: false,
    },
    {
      name: 'slash date that can only be day-first',
      text: '[13/03/2026 09:12 UTC] Customer: hi',
      expected: '2026-03-13T09:12:00Z',
      zoneAssumed: false,
    },
    {
      name: 'slash date that can only be month-first',
      text: '[03/13/2026 09:12 UTC] Customer: hi',
      expected: '2026-03-13T09:12:00Z',
      zoneAssumed: false,
    },
    {
      name: 'ambiguous slash date resolved by dateOrder mdy',
      text: '[03/09/2026 09:12 UTC] Customer: hi',
      extra: { dateOrder: 'mdy' },
      expected: '2026-03-09T09:12:00Z',
      zoneAssumed: false,
    },
    {
      name: 'ambiguous slash date resolved by dateOrder dmy',
      text: '[03/09/2026 09:12 UTC] Customer: hi',
      extra: { dateOrder: 'dmy' },
      expected: '2026-09-03T09:12:00Z',
      zoneAssumed: false,
    },
    {
      name: 'fractional seconds are kept',
      text: '[2026-03-09 09:12:30.250 UTC] Customer: hi',
      expected: '2026-03-09T09:12:30.250Z',
      zoneAssumed: false,
    },
  ];

  it.each(cases)('[FR-ING-01] reads $name', ({ text, extra, expected, zoneAssumed }) => {
    const draft = expectOk(parse(text, extra));
    expect(draft.bundle.events[0]?.timestamp).toBe(expected);
    expect(codes(draft).includes('timezone_assumed')).toBe(zoneAssumed);
    expectValidDraft(draft.bundle);
  });

  it('[FR-ING-01] assumes UTC for stamps without a zone and warns once with a count', () => {
    const draft = expectOk(
      parse('[2026-03-09 09:12] Customer: one\n[2026-03-09 09:13] Support: two'),
    );
    const zone = draft.warnings.filter((w) => w.code === 'timezone_assumed');
    expect(zone).toHaveLength(1);
    expect(zone[0]).toMatchObject({ severity: 'warning', count: 2 });
    expect(zone[0]?.message).toContain('UTC was assumed');
  });

  it('[FR-ING-01] applies an assumed offset instead of UTC and says so', () => {
    const draft = expectOk(
      parse('[2026-03-09 09:12] Customer: hi', { assumedUtcOffsetMinutes: 120 }),
    );
    expect(draft.bundle.events[0]?.timestamp).toBe('2026-03-09T07:12:00Z');
    expect(draft.warnings.find((w) => w.code === 'timezone_assumed')?.message).toContain(
      'UTC+02:00',
    );
  });

  it('[FR-ING-01] does not interpret ambiguous zone abbreviations such as CST', () => {
    const draft = expectOk(parse('[2026-03-09 09:12 CST] Customer: hi'));
    expect(draft.bundle.events[0]?.timestamp).toBe('2026-03-09T09:12:00Z');
    expect(codes(draft)).toContain('timezone_unrecognised');
  });

  it('[FR-ING-01] refuses to guess an ambiguous slash date', () => {
    const result = parse('[03/09/2026 09:12 UTC] Customer: hi');
    const failure = expectFailure(result);
    expect(failure.errors[0]?.code).toBe('no_timestamps');
    expect(codes(failure)).toContain('timestamp_unresolved');
    expect(failure.warnings.find((w) => w.code === 'timestamp_unresolved')?.message).toContain(
      'day/month or month/day',
    );
  });

  it('[FR-ING-01] reports an impossible date instead of silently moving it', () => {
    const draft = expectOk(
      parse('[2026-02-30 09:12 UTC] Customer: bad date\n[2026-03-01 09:12 UTC] Support: ok'),
    );
    expect(draft.bundle.events.map((e) => e.timestamp)).toEqual([
      '2026-03-01T09:12:00Z',
      '2026-03-01T09:12:00Z',
    ]);
    expect(draft.warnings.find((w) => w.code === 'timestamp_unresolved')?.message).toContain(
      'not a calendar date',
    );
    expect(draft.eventNotes.map((n) => n.timestampBasis)).toEqual(['inherited', 'explicit']);
  });

  it('[FR-ING-01] uses the date line for time-only chats and carries it forward', () => {
    const text = [
      '=== Tuesday, 10 March 2026 ===',
      '09:12 UTC Customer: first',
      '09:40 UTC Support: second',
      '2026-03-11',
      '08:00 UTC Customer: next day',
    ].join('\n');
    const draft = expectOk(parse(text));
    expect(draft.bundle.events.map((e) => e.timestamp)).toEqual([
      '2026-03-10T09:12:00Z',
      '2026-03-10T09:40:00Z',
      '2026-03-11T08:00:00Z',
    ]);
    expect(codes(draft)).not.toContain('date_assumed');
  });

  it('[FR-ING-01] falls back to the injected clock date for time-only chats and warns loudly', () => {
    const draft = expectOk(parse('09:12 UTC Customer: hi'));
    expect(draft.bundle.events[0]?.timestamp).toBe('2026-10-29T09:12:00Z');
    const warning = draft.warnings.find((w) => w.code === 'date_assumed');
    expect(warning?.severity).toBe('warning');
    expect(warning?.message).toContain('ingestion clock');
    expect(draft.eventNotes[0]?.timestampBasis).toBe('date_assumed');
  });

  it('[FR-ING-01] a default date is reported as information, not a guess', () => {
    const draft = expectOk(parse('09:12 UTC Customer: hi', { defaultDate: '2026-03-09' }));
    expect(draft.warnings.find((w) => w.code === 'date_assumed')?.severity).toBe('info');
  });

  it('[FR-ING-01] places time-only stamps that run past midnight on the next day and warns', () => {
    const text = [
      '2026-03-09 23:50 UTC Customer: late',
      '00:10 UTC Support: after midnight',
      '00:30 UTC Customer: still after midnight',
    ].join('\n');
    const draft = expectOk(parse(text));
    expect(draft.bundle.events.map((e) => e.timestamp)).toEqual([
      '2026-03-09T23:50:00Z',
      '2026-03-10T00:10:00Z',
      '2026-03-10T00:30:00Z',
    ]);
    expect(codes(draft)).toContain('date_rollover_assumed');
  });

  it('[FR-ING-01] sorts out-of-order messages and says so; equal stamps keep source order', () => {
    const text = [
      '[2026-03-09 10:00 UTC] Support: third',
      '[2026-03-09 09:00 UTC] Customer: first',
      '[2026-03-09 09:00 UTC] Support: second',
    ].join('\n');
    const draft = expectOk(parse(text));
    expect(draft.bundle.events.map((e) => e.body)).toEqual(['first', 'second', 'third']);
    expect(draft.bundle.events.map((e) => e.id)).toEqual(['e01', 'e02', 'e03']);
    expect(codes(draft)).toContain('events_reordered');
  });

  it('[FR-ING-01] lets unstamped speaker lines inherit the previous time and warns', () => {
    const text = '[2026-03-09 09:00 UTC] Customer: hello\nCustomer: and another thing';
    const draft = expectOk(parse(text));
    expect(draft.bundle.events).toHaveLength(2);
    expect(draft.bundle.events[1]?.timestamp).toBe('2026-03-09T09:00:00Z');
    expect(draft.eventNotes[1]?.timestampBasis).toBe('inherited');
    expect(codes(draft)).toContain('timestamp_inherited');
  });
});

describe('parsePastedTranscript: speakers and roles', () => {
  const labels: {
    label: string;
    role: ParticipantRole;
    basis: string;
    ambiguous?: boolean;
  }[] = [
    { label: 'Customer', role: 'customer_admin', basis: 'generic_customer' },
    { label: 'Contoso admin', role: 'customer_admin', basis: 'keyword' },
    { label: 'Fabrikam IT admin', role: 'customer_admin', basis: 'keyword' },
    { label: 'Support', role: 'support_engineer', basis: 'keyword' },
    { label: 'Engineer', role: 'support_engineer', basis: 'keyword' },
    { label: 'Support Engineer 2', role: 'support_engineer', basis: 'keyword' },
    { label: 'Escalation Engineer', role: 'escalation_engineer', basis: 'keyword' },
    { label: 'Identity Escalation Engineer', role: 'escalation_engineer', basis: 'keyword' },
    { label: 'Support Manager', role: 'support_manager', basis: 'keyword' },
    { label: 'Case System', role: 'system', basis: 'keyword' },
    { label: 'Automation bot', role: 'system', basis: 'keyword' },
    { label: 'Network Admin', role: 'customer_network_admin', basis: 'keyword' },
    { label: 'End user', role: 'customer_end_user', basis: 'keyword' },
    { label: 'Anna Schmidt', role: 'system', basis: 'unknown' },
    { label: 'Anna Schmidt (Support Engineer)', role: 'support_engineer', basis: 'keyword' },
    { label: 'Customer Engineer', role: 'support_engineer', basis: 'keyword', ambiguous: true },
    { label: 'Contoso manager', role: 'customer_admin', basis: 'keyword', ambiguous: true },
  ];

  it.each(labels)('[FR-ING-01] infers $role from "$label"', ({ label, role, basis, ambiguous }) => {
    const inferred = inferRole(splitSpeakerLabel(label));
    expect(inferred).toMatchObject({ role, basis, ambiguous: ambiguous ?? false });
  });

  it('[FR-ING-01] uses pseudonymous aliases and never copies names into the bundle', () => {
    const text = [
      '[2026-03-09 09:00 UTC] Anna Schmidt (Support Engineer) <anna.schmidt@example.invalid>: Hello',
      '[2026-03-09 09:05 UTC] Bob Meyer (customer admin): Hi Anna',
    ].join('\n');
    const draft = expectOk(parse(text));
    const aliases = draft.bundle.participants.map((p) => p.alias);
    expect(aliases).toEqual(['Support Engineer 1', 'Customer IT Admin 1']);
    const participantsJson = JSON.stringify(draft.bundle.participants);
    expect(participantsJson).not.toMatch(/Anna|Bob|Schmidt|Meyer|example\.invalid/);
    expect(draft.speakers.map((s) => s.alias)).toEqual(aliases);
  });

  it('[FR-ING-01] keeps unidentifiable speakers neutral and warns instead of guessing a side', () => {
    const draft = expectOk(parse('[2026-03-09 09:00 UTC] Anna Schmidt: please look at this'));
    expect(draft.bundle.participants[0]).toMatchObject({
      role: 'system',
      alias: 'Unidentified Participant 1',
    });
    expect(draft.bundle.events[0]?.type).toBe('case_note');
    const warning = draft.warnings.find((w) => w.code === 'role_unknown');
    expect(warning?.message).toContain('Anna Schmidt');
    expect(warning?.hint).toContain('role word');
    expect(draft.confidence.score).toBeLessThan(0.8);
  });

  it('[FR-ING-01] honours explicit speakerRoles for labels the keywords cannot decide', () => {
    const draft = expectOk(
      parse('[2026-03-09 09:00 UTC] Anna Schmidt: hi', {
        speakerRoles: { 'anna schmidt': 'customer_end_user' },
      }),
    );
    expect(draft.bundle.participants[0]?.role).toBe('customer_end_user');
    expect(draft.speakers[0]?.roleBasis).toBe('override');
    expect(codes(draft)).not.toContain('role_unknown');
  });

  it('[FR-ING-01] recognises one person across e-mail headers and chat lines', () => {
    const text = [
      'From: Support Engineer <eng@support-synthetic.invalid>',
      'Sent: 2026-03-09 09:00 UTC',
      'Subject: Hello',
      '',
      'Hello, how can I help?',
      '',
      '[2026-03-09 09:30 UTC] Support Engineer: Checked the logs.',
    ].join('\n');
    const draft = expectOk(parse(text));
    expect(draft.bundle.participants).toHaveLength(1);
  });

  it('[FR-ING-01] merges speakers beyond the participant limit by role and says so', () => {
    const lines = Array.from(
      { length: 12 },
      (_, i) =>
        `[2026-03-09 09:${String(i).padStart(2, '0')} UTC] Customer ${String.fromCharCode(65 + i)} user: hi`,
    );
    const draft = expectOk(parse(lines.join('\n'), { limits: { maxParticipants: 10 } }));
    expect(draft.bundle.participants.length).toBeLessThanOrEqual(10);
    expect(codes(draft)).toContain('speakers_merged');
    expect(draft.confidence.reasons.join(' ')).toContain('merged');
  });
});
