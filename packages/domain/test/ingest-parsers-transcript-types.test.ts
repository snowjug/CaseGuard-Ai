import { describe, expect, it } from 'vitest';
import type { EventType } from '@caseguard/schemas';
import { parsePastedTranscript, type IngestTypeBasis } from '../src/ingest/parsers';
import { BASE, expectOk } from './ingest-parsers.helpers';

const parse = (text: string) => parsePastedTranscript(text, BASE);

describe('parsePastedTranscript: event types', () => {
  const kql = '| where TimeGenerated > ago(1h)\n| summarize count() by ResultType\n| take 10';
  const cases: {
    name: string;
    label: string;
    body: string;
    type: EventType;
    basis: IngestTypeBasis;
  }[] = [
    {
      name: 'customer message',
      label: 'Customer',
      body: 'Teams fails.',
      type: 'customer_email',
      basis: 'customer_side',
    },
    {
      name: 'customer e-mail with greeting',
      label: 'Customer',
      body: 'Hello,\nit fails.\nThanks',
      type: 'customer_email',
      basis: 'email_block',
    },
    {
      name: 'customer call note',
      label: 'Customer',
      body: 'Call notes: user rang about errors',
      type: 'customer_call',
      basis: 'call_marker',
    },
    {
      name: 'engineer e-mail with greeting and sign-off',
      label: 'Support Engineer',
      body: 'Hello,\nplease send logs.\nRegards',
      type: 'engineer_email',
      basis: 'salutation',
    },
    {
      name: 'engineer action',
      label: 'Support Engineer',
      body: 'Ran the sign-in log query.',
      type: 'engineer_action',
      basis: 'action_verb',
    },
    {
      name: 'engineer query output',
      label: 'Support Engineer',
      body: kql,
      type: 'query_output',
      basis: 'code_like',
    },
    {
      name: 'log lines',
      label: 'Support Engineer',
      body: '2026-03-09 09:00:01 ERROR timeout\n2026-03-09 09:00:02 ERROR timeout\n2026-03-09 09:00:03 WARN retry',
      type: 'log_sample',
      basis: 'code_like',
    },
    {
      name: 'customer pasting command output',
      label: 'Customer',
      body: '  Name  Value\n  a     1\n  b     2',
      type: 'diagnostic_result',
      basis: 'code_like',
    },
    {
      name: 'validation',
      label: 'Support Engineer',
      body: 'Validation: 100 requests passed.',
      type: 'validation_result',
      basis: 'validation_pattern',
    },
    {
      name: 'resolution note',
      label: 'Support Engineer',
      body: 'Resolution summary. Root cause: DNS.',
      type: 'resolution_note',
      basis: 'resolution_pattern',
    },
    {
      name: 'escalation',
      label: 'Support Engineer',
      body: 'Escalating to the identity team.',
      type: 'escalation',
      basis: 'escalation_pattern',
    },
    {
      name: 'escalation response',
      label: 'Escalation Engineer',
      body: 'Reviewed the traces.',
      type: 'escalation_response',
      basis: 'escalation_pattern',
    },
    {
      name: 'status change',
      label: 'Case System',
      body: 'Status changed to Resolved.',
      type: 'status_change',
      basis: 'status_pattern',
    },
    {
      name: 'system message',
      label: 'Case System',
      body: 'Escalation accepted.',
      type: 'system_event',
      basis: 'system_role',
    },
    {
      name: 'neutral engineer note',
      label: 'Support Engineer',
      body: 'Server-side logs show nothing.',
      type: 'case_note',
      basis: 'default',
    },
    {
      name: 'explicit qualifier wins',
      label: 'Support Engineer (case note)',
      body: 'Ran the query.',
      type: 'case_note',
      basis: 'explicit',
    },
  ];

  it.each(cases)('[FR-ING-01] types a $name as $type', ({ label, body, type, basis }) => {
    const text = `[2026-03-09 09:00 UTC] ${label}: ${body.includes('\n') ? `\n${body}` : body}`;
    const draft = expectOk(parse(text));
    expect(draft.bundle.events[0]?.type).toBe(type);
    expect(draft.eventNotes[0]?.typeBasis).toBe(basis);
  });

  it('[FR-ING-01] reports neutral defaults as information so nothing looks decided by evidence', () => {
    const draft = expectOk(parse('[2026-03-09 09:00 UTC] Support Engineer: Logs look empty.'));
    const warning = draft.warnings.find((w) => w.code === 'event_type_defaulted');
    expect(warning).toMatchObject({ severity: 'info', count: 1 });
    expect(warning?.hint).toContain('qualifier');
  });

  it('[FR-ING-01] keeps multi-line bodies and the blank lines between paragraphs', () => {
    const text = '[2026-03-09 09:00 UTC] Customer: first line\nsecond line\n\nthird paragraph';
    expect(expectOk(parse(text)).bundle.events[0]?.body).toBe(
      'first line\nsecond line\n\nthird paragraph',
    );
  });

  it('[FR-ING-01] does not split a message on prose such as "System: Windows 11"', () => {
    const text = [
      '[2026-03-09 09:00 UTC] Customer: Environment details',
      'System: Windows 11',
      'Version: 23H2',
      '[2026-03-09 09:05 UTC] Support: Thanks.',
    ].join('\n');
    const draft = expectOk(parse(text));
    expect(draft.bundle.events).toHaveLength(2);
    expect(draft.bundle.events[0]?.body).toContain('System: Windows 11');
  });

  it('[FR-ING-01] keeps code fences together even when lines look like new messages', () => {
    const text = [
      '[2026-03-09 09:00 UTC] Support Engineer: Output:',
      '```',
      '[2026-03-09 09:01 UTC] Customer: not a message',
      '```',
    ].join('\n');
    const draft = expectOk(parse(text));
    expect(draft.bundle.events).toHaveLength(1);
    expect(draft.bundle.events[0]?.body).toContain('not a message');
  });
});
