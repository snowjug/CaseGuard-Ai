import { describe, expect, it } from 'vitest';
import {
  IngestParseError,
  parsePastedTranscript,
  type IngestDraftOptions,
} from '../src/ingest/parsers';
import {
  BASE,
  NOW,
  codes,
  expectFailure,
  expectOk,
  expectValidDraft,
} from './ingest-parsers.helpers';

const parse = (text: string, extra: Partial<IngestDraftOptions> = {}) =>
  parsePastedTranscript(text, { ...BASE, ...extra });

const email = (from: string, sent: string, subject: string, body: string, to = 'Support') =>
  [`From: ${from}`, `Sent: ${sent}`, `To: ${to}`, `Subject: ${subject}`, '', body].join('\n');

describe('parsePastedTranscript: e-mail blocks and quoted replies', () => {
  it('[FR-ING-01] reads From/Sent/Subject blocks as e-mails with header timestamps', () => {
    const text = [
      email(
        'Fabrikam IT admin',
        'Tuesday, 14 April 2026 07:35 UTC',
        'Sign-in fails',
        'Hello,\n\nUsers cannot sign in.',
      ),
      '',
      email(
        'Support Engineer',
        'Tuesday, 14 April 2026 07:52 UTC',
        'Re: Sign-in fails',
        'Hello,\n\nPlease send logs.\n\nRegards',
      ),
    ].join('\n');
    const draft = expectOk(parse(text));
    expect(draft.bundle.events.map((e) => [e.type, e.channel, e.title, e.timestamp])).toEqual([
      ['customer_email', 'email', 'Sign-in fails', '2026-04-14T07:35:00Z'],
      ['engineer_email', 'email', 'Re: Sign-in fails', '2026-04-14T07:52:00Z'],
    ]);
    expect(draft.eventNotes.map((n) => n.timestampBasis)).toEqual(['header', 'header']);
    expect(draft.bundle.events[0]?.body).toBe('Hello,\n\nUsers cannot sign in.');
  });

  it('[FR-ING-01] links a Re: subject to the earlier message of the same thread only', () => {
    const text = [
      email(
        'Support Engineer',
        '2026-03-09 09:00 UTC',
        'Logs please',
        'Hello,\nplease send logs.\nRegards',
      ),
      email('Contoso admin', '2026-03-09 10:00 UTC', 'Re: Logs please', 'Sent.'),
      email('Contoso admin', '2026-03-09 11:00 UTC', 'Something unrelated', 'FYI.'),
    ].join('\n\n');
    const draft = expectOk(parse(text));
    const [first, second, third] = draft.bundle.events;
    expect(second?.inResponseTo).toBe(first?.id);
    expect(third?.inResponseTo).toBeUndefined();
    expect(draft.eventNotes[1]?.inResponseToBasis).toBe('subject_thread');
  });

  it('[FR-ING-01] sorts a newest-first thread chronologically and explains why', () => {
    const text = [
      email('Contoso admin', '2026-03-09 11:00 UTC', 'Re: Logs', 'Here they are.'),
      email(
        'Support Engineer',
        '2026-03-09 09:00 UTC',
        'Logs',
        'Hello,\nplease send logs.\nRegards',
      ),
    ].join('\n\n');
    const draft = expectOk(parse(text));
    expect(draft.bundle.events.map((e) => e.title)).toEqual(['Logs', 'Re: Logs']);
    expect(draft.bundle.events[1]?.inResponseTo).toBe('e01');
    expect(codes(draft)).toContain('events_reordered');
  });

  it('[FR-ING-01] strips a quoted "On ... wrote:" block and keeps only the new reply', () => {
    const text = [
      email(
        'Contoso admin',
        '2026-03-09 11:00 UTC',
        'Re: Logs',
        [
          'Here are the logs.',
          '',
          'On Mon, 9 Mar 2026 at 09:00, Support Engineer <eng@support-synthetic.invalid> wrote:',
          '> Hello,',
          '> please send logs.',
          '>',
          '> Regards',
        ].join('\n'),
      ),
    ].join('\n');
    const draft = expectOk(parse(text));
    expect(draft.bundle.events[0]?.body).toBe('Here are the logs.');
    const warning = draft.warnings.find((w) => w.code === 'quoted_text_removed');
    expect(warning).toMatchObject({ severity: 'info', count: 5 });
  });

  it('[FR-ING-01] strips an attribution that wraps onto two lines', () => {
    const body = [
      'Thanks, done.',
      'On Monday, March 9, 2026 at 9:00 AM Support Engineer <eng@support-synthetic.invalid>',
      'wrote:',
      '> Please restart.',
    ].join('\n');
    const draft = expectOk(
      parse(email('Contoso admin', '2026-03-09 11:00 UTC', 'Re: Restart', body)),
    );
    expect(draft.bundle.events[0]?.body).toBe('Thanks, done.');
  });

  it('[FR-ING-01] keeps inline replies that follow quoted lines', () => {
    const body = [
      'On Mon, 9 Mar 2026 at 09:00, Support Engineer wrote:',
      '> Did you restart?',
      'Yes, twice.',
      '> Did it help?',
      'No.',
    ].join('\n');
    const draft = expectOk(
      parse(email('Contoso admin', '2026-03-09 11:00 UTC', 'Re: Restart', body)),
    );
    expect(draft.bundle.events[0]?.body).toBe('Yes, twice.\nNo.');
  });

  it('[FR-ING-01] keeps a lone ">" line and anything inside a code fence', () => {
    const body =
      'Run this:\n> nslookup login.microsoftonline.com\n```\n> not quoted\n> also kept\n```';
    const draft = expectOk(parse(email('Support Engineer', '2026-03-09 11:00 UTC', 'Steps', body)));
    expect(draft.bundle.events[0]?.body).toBe(body);
    expect(codes(draft)).not.toContain('quoted_text_removed');
  });

  it('[FR-ING-01] never empties a message: a fully quoted reply is kept as it is', () => {
    const body = ['On Mon, 9 Mar 2026 at 09:00, Support wrote:', '> only quoted text'].join('\n');
    const draft = expectOk(parse(email('Contoso admin', '2026-03-09 11:00 UTC', 'Re: x', body)));
    expect(draft.bundle.events[0]?.body).toContain('only quoted text');
  });

  it('[FR-ING-01] drops "Original Message" separators from the end of a message', () => {
    const text = [
      email(
        'Contoso admin',
        '2026-03-09 11:00 UTC',
        'Re: Logs',
        'Thanks.\n\n-----Original Message-----',
      ),
      email(
        'Support Engineer',
        '2026-03-09 09:00 UTC',
        'Logs',
        'Hello,\nplease send logs.\nRegards',
      ),
    ].join('\n');
    expect(expectOk(parse(text)).bundle.events[1]?.body).toBe('Thanks.');
  });

  it('[FR-ING-01] a sentence that merely starts with "From:" is not an e-mail header', () => {
    const text =
      '[2026-03-09 09:00 UTC] Customer: Details\nFrom: the logs we see timeouts.\nPlease help.';
    const draft = expectOk(parse(text));
    expect(draft.bundle.events).toHaveLength(1);
    expect(draft.bundle.events[0]?.body).toContain('From: the logs');
  });

  it('[FR-ING-01] links a customer reply to an engineer request that asked for something', () => {
    const text = [
      '[2026-03-09 09:00 UTC] Support Engineer: Hello,\nplease send the proxy names.\nRegards',
      '[2026-03-09 09:30 UTC] Customer: proxy-1 and proxy-2.',
    ].join('\n');
    const draft = expectOk(parse(text));
    expect(draft.bundle.events[1]?.inResponseTo).toBe('e01');
    expect(draft.eventNotes[1]?.inResponseToBasis).toBe('request_reply');
  });

  it('[FR-ING-01] does not link a reply when the engineer asked for nothing', () => {
    const text = [
      '[2026-03-09 09:00 UTC] Support Engineer: Hello,\nI am looking into it.\nRegards',
      '[2026-03-09 09:30 UTC] Customer: ok.',
    ].join('\n');
    expect(expectOk(parse(text)).bundle.events[1]?.inResponseTo).toBeUndefined();
  });

  it('[FR-ING-01] links tool output to the action directly before it', () => {
    const text = [
      '[2026-03-09 09:00 UTC] Support Engineer: Ran the sign-in query.',
      '[2026-03-09 09:05 UTC] Support Engineer:\n| where TimeGenerated > ago(1h)\n| summarize count()\n| take 5',
    ].join('\n');
    const draft = expectOk(parse(text));
    expect(draft.bundle.events[1]).toMatchObject({ type: 'query_output', inResponseTo: 'e01' });
  });
});

describe('parsePastedTranscript: case details, resolution and honesty labels', () => {
  const base = '[2026-03-09 09:00 UTC] Customer: Teams sign-in fails for 40 users.';

  it('[FR-ING-01] requires an explicit synthetic flag', () => {
    expect(() =>
      parsePastedTranscript(base, { now: NOW } as unknown as IngestDraftOptions),
    ).toThrow(IngestParseError);
  });

  it('[FR-ING-01] labels a synthetic draft, and a real one is not labelled synthetic', () => {
    const synthetic = expectOk(parse(base));
    expect(synthetic.bundle.synthetic).toBe(true);
    expect(synthetic.bundle.syntheticNotice).toContain('SYNTHETIC');
    expect(synthetic.bundle.case.tags).toContain('synthetic');
    const real = expectOk(parse(base, { synthetic: false }));
    expect(real.bundle.synthetic).toBe(false);
    expect(real.bundle.syntheticNotice).toBeUndefined();
    expect(real.bundle.case.customerAlias).toBe('Customer (unnamed)');
  });

  it('[FR-ING-01] reads explicit case details from the lines before the first message', () => {
    const text = [
      'Notice: synthetic banner that is ignored on purpose',
      'Title: Intermittent Teams sign-in failures at Rotterdam',
      'Reference: cg syn 2001',
      'Product: Microsoft Teams',
      'Workload: teams-authentication',
      'Severity: B',
      'Customer alias: Fabrikam Synthetic BV',
      'Some stray line',
      base,
    ].join('\n');
    const draft = expectOk(parse(text));
    expect(draft.bundle.case).toMatchObject({
      title: 'Intermittent Teams sign-in failures at Rotterdam',
      reference: 'CG-SYN-2001',
      product: 'Microsoft Teams',
      workload: 'teams-authentication',
      severity: 'B',
      customerAlias: 'Fabrikam Synthetic BV',
    });
    const ignored = draft.warnings.find((w) => w.code === 'preamble_ignored');
    expect(ignored).toMatchObject({ count: 1 });
    expect(ignored?.message).toContain('source 8');
  });

  it('[FR-ING-01] lets explicit options override the text and reports what was defaulted', () => {
    const draft = expectOk(
      parse(['Title: From the text', base].join('\n'), { title: 'From the options' }),
    );
    expect(draft.bundle.case.title).toBe('From the options');
    const defaults = draft.warnings.find((w) => w.code === 'metadata_defaulted');
    expect(defaults?.message).toContain('product');
    expect(defaults?.message).toContain('severity');
    expect(draft.bundle.case.severity).toBe('C');
  });

  it('[FR-ING-01] says so when the workload is assumed', () => {
    const assumed = expectOk(parse(base));
    expect(assumed.bundle.case.workload).toBe('teams-authentication');
    expect(assumed.warnings.find((w) => w.code === 'workload_assumed')?.severity).toBe('warning');
    expect(codes(expectOk(parse(base, { workload: 'teams-authentication' })))).not.toContain(
      'workload_assumed',
    );
  });

  it('[FR-ING-01] derives a title from the first customer sentence, never inventing one', () => {
    expect(expectOk(parse(base)).bundle.case.title).toBe('Teams sign-in fails for 40 users');
    const noTitle = expectOk(parse('[2026-03-09 09:00 UTC] Customer: ok'));
    expect(noTitle.bundle.case.title).toBe('Pasted case transcript');
    expect(noTitle.warnings.find((w) => w.code === 'metadata_defaulted')?.message).toContain(
      'title',
    );
  });

  it('[FR-ING-01] extracts a resolution only from an explicit "Root cause:" statement', () => {
    const text = [
      base,
      '[2026-03-09 15:00 UTC] Support Engineer: Resolution summary. Root cause: proxy-rtm-2 saturated. Workaround: removed it from rotation. Permanent fix: bypass inspection; review capacity.',
      '[2026-03-09 15:05 UTC] Case System: Status changed to Resolved.',
    ].join('\n');
    const draft = expectOk(parse(text));
    expect(draft.bundle.resolution).toMatchObject({
      resolvedAt: '2026-03-09T15:00:00Z',
      rootCause: 'proxy-rtm-2 saturated.',
      workaround: 'removed it from rotation.',
      permanentFix: 'bypass inspection; review capacity.',
    });
    expect(draft.bundle.resolution?.rootCauseHypothesisKey).toBeUndefined();
    expect(draft.bundle.case).toMatchObject({
      status: 'resolved',
      closedAt: '2026-03-09T15:05:00Z',
    });

    const without = expectOk(
      parse(
        [base, '[2026-03-09 15:00 UTC] Support Engineer: Resolution summary. It works now.'].join(
          '\n',
        ),
      ),
    );
    expect(without.bundle.resolution).toBeUndefined();
    expect(without.bundle.case.status).toBe('open');
    expect(codes(without)).toContain('resolution_not_extracted');
  });

  it('[FR-ING-01] is deterministic and uses the injected ids and clock', () => {
    const text = `${base}\n[2026-03-09 09:30 UTC] Support Engineer: Ran the query.`;
    const a = expectOk(parse(text));
    const b = expectOk(parse(text));
    expect(a).toEqual(b);
    const custom = expectOk(
      parse(text, {
        ids: {
          eventId: (i) => `evt-${i + 100}`,
          participantId: (role, n) => `part-${role}-${n}`,
        },
      }),
    );
    expect(custom.bundle.events.map((e) => e.id)).toEqual(['evt-100', 'evt-101']);
    expect(custom.bundle.participants.map((p) => p.id)).toEqual([
      'part-customer_admin-1',
      'part-support_engineer-1',
    ]);
    expectValidDraft(custom.bundle);
  });

  it('[FR-ING-01] warns about events dated after the injected clock', () => {
    const draft = expectOk(parse('[2031-03-09 09:00 UTC] Customer: from the future'));
    expect(codes(draft)).toContain('timestamp_in_future');
  });

  it('[FR-ING-01] default references are content-derived so identical text gets one reference', () => {
    const a = expectOk(parse(base)).bundle.case.reference;
    const b = expectOk(parse(base)).bundle.case.reference;
    const c = expectOk(parse(`${base}\n[2026-03-09 09:05 UTC] Support: more`)).bundle.case
      .reference;
    expect(a).toMatch(/^CG-DRAFT-[0-9A-F]{8}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('parsePastedTranscript: failures are friendly and never guessed', () => {
  it('[FR-ING-02] explains the accepted formats when no message can be found', () => {
    const failure = expectFailure(parse('Hello, the proxy is slow and users are angry.'));
    expect(failure.errors[0]).toMatchObject({ code: 'no_turns', path: '(input)' });
    expect(failure.errors[0]?.hint).toContain('[2026-03-09 09:12] Customer:');
    expect(failure.errors[0]?.received).toBe('Hello, the proxy is slow and users are angry.');
  });

  it('[FR-ING-02] says why a transcript without any timestamp cannot be used', () => {
    const failure = expectFailure(parse('From: Contoso admin\nSubject: Help\n\nIt fails.'));
    expect(failure.errors[0]?.code).toBe('no_timestamps');
    expect(failure.errors[0]?.message).toContain('order and timing');
  });

  it('[FR-ING-02] rejects empty and blank input with the format hint', () => {
    expect(expectFailure(parse('   \n\n')).errors[0]?.code).toBe('input_empty');
    expect(expectFailure(parse('')).errors[0]?.hint).toContain('timestamp');
  });
});
