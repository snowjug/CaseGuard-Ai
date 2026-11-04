import { describe, expect, it } from 'vitest';
import type { CaseEvent, EventType, ParticipantRole } from '@caseguard/schemas';
import { createFullView, detectObservations, getCompiledPack } from '../src';

/**
 * Wording families for the signals about the server side (what the logs, the name servers, the proxies, the federation and
 * the devices show, and what changed in the access policy). For each family: sentences the detectors must read and look-alikes
 * they must not. The sentences are written for this test, not taken from the evaluation cases, so passing here does not
 * depend on those cases. The families of the other signals are in `detector-families.test.ts`.
 */
const pack = (() => {
  const compiled = getCompiledPack('teams-authentication');
  if (!compiled) throw new Error('the Teams pack is missing');
  return compiled;
})();

let counter = 0;
function eventOf(role: ParticipantRole, type: EventType, body: string): CaseEvent {
  counter += 1;
  return {
    tenantId: 'tenant_test',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'test',
    version: 1,
    id: `fam_${counter}`,
    caseId: 'case_fam',
    sourceId: 'src_fam',
    sequence: counter,
    timestamp: '2026-01-01T08:00:00.000Z',
    participantId: `p_${role}`,
    participantRole: role,
    participantAlias: role,
    type,
    channel: 'email',
    title: null,
    body,
    action: null,
    inResponseTo: null,
    correlationIds: [],
    structured: null,
    ai: null,
    sourcePointer: `/events/${counter}`,
    redaction: { redacted: false, categories: [] },
    immutable: true,
  };
}

const observationsOf = (event: CaseEvent) =>
  detectObservations(createFullView([event], null), pack, 'case_fam');
const signalsOf = (event: CaseEvent): string[] => observationsOf(event).map((o) => o.signalId);

interface Family {
  readonly id: string;
  readonly signal: string;
  readonly role: ParticipantRole;
  readonly type: EventType;
  readonly reads: readonly string[];
  readonly doesNotRead: readonly string[];
}

const FAMILIES: readonly Family[] = [
  {
    id: 'no failed row: the row noun, singular or plural, with or without "sign-in"',
    signal: 'sig.no-server-side-failure-records',
    role: 'support_engineer',
    type: 'diagnostic_result',
    reads: [
      'Went through SigninLogs for the six users: not one failed sign-in record at any of the times they reported.',
      'Zero failure entries in Entra for those accounts across the whole afternoon.',
      "There is no matching failed row for Dana's 10:42 attempt.",
      'We found no sign-in events for either pilot user in the minutes around the failures.',
      'I could not find any matching entry for these accounts in the sign-in logs.',
      'Quick update: no failure records exist for the five people on your list.',
      'Entra had no failed sign-in rows for any user on the list, so the problem sits before Microsoft.',
    ],
    doesNotRead: [
      'Please check whether the sign-in logs hold failed rows for these users.',
      'If Entra shows no failed rows for them, we move on to the network path.',
      'I will search the sign-in logs for failed rows tomorrow.',
      'The logs show failed sign-in rows for each of them.',
      'It might be that Entra holds failed rows for them.',
      'No problem, the sign-in logs are attached to this note.',
    ],
  },
  {
    id: 'no failed row: the log as the subject ("came back empty", "are clean")',
    signal: 'sig.no-server-side-failure-records',
    role: 'support_engineer',
    type: 'diagnostic_result',
    reads: [
      'The Entra sign-in logs came back empty for all four users.',
      'SigninLogs returned no rows for the failing attempts.',
      'Sign-in logs for the group are clean for that window.',
      'The logs show nothing for any of the accounts.',
      'Entra did not log anything for those users around the failure times.',
      'I looked in the sign-in logs and found nothing for these people.',
      'Entra never saw these sign-ins.',
      'Sign-in logs for the affected group: nothing at all.',
    ],
    doesNotRead: [
      'Please check whether the sign-in logs hold nothing for these users.',
      'Maybe the requests never reached Entra.',
      'The proxy logs are clean for that window.',
      'Nothing changed in the audit log for the access policy.',
      'Teams works for them again and there are no more failures.',
    ],
  },
  {
    id: 'no failed row: the attempts are not in the log',
    signal: 'sig.no-server-side-failure-records',
    role: 'support_engineer',
    type: 'diagnostic_result',
    reads: [
      'None of the failing attempts show up in Entra.',
      'The failed sign-ins are not recorded anywhere in the sign-in logs.',
      'These attempts do not appear in SigninLogs.',
      'Nothing was recorded in Entra for any of those sign-ins.',
    ],
    doesNotRead: [
      'These attempts will not appear in SigninLogs until the export is done.',
      'The attempts appear in SigninLogs with a result code.',
    ],
  },
  {
    id: 'no failed row: the request never reached the service',
    signal: 'sig.no-server-side-failure-records',
    role: 'support_engineer',
    type: 'engineer_email',
    reads: [
      'The failing requests never reached Entra.',
      'These attempts do not even get as far as the identity service.',
      'The sign-in attempts never arrived at the Microsoft service.',
    ],
    doesNotRead: [
      'Maybe the requests never reached Entra.',
      'If the requests do not reach Entra we can rule out the policy.',
      'Teams cannot reach the server, says the customer.',
    ],
  },
  {
    id: 'no failed row: a customer administrator who opened the log',
    signal: 'sig.no-server-side-failure-records',
    role: 'customer_admin',
    type: 'customer_email',
    reads: [
      'I looked in our Entra sign-in logs myself and there are no failed sign-ins for these users.',
      'Nothing in the Entra sign-in logs for any of the affected accounts.',
    ],
    doesNotRead: [
      'I do not know how to look in the Entra sign-in logs for failed sign-ins.',
      'We will check the Entra sign-in logs for failed sign-ins after lunch.',
    ],
  },
  {
    id: 'failed row: at each of the times given',
    signal: 'sig.server-side-failure-records-present',
    role: 'support_engineer',
    type: 'diagnostic_result',
    reads: [
      'Entra has a failed sign-in row for each of the times you gave.',
      'Failed sign-in entries exist for all of those moments.',
      'SigninLogs shows a failed attempt at every reported time.',
      'All the failing attempts are in the sign-in logs at the minutes you listed.',
    ],
    doesNotRead: [
      'Please look for a failed row at each time they gave.',
      'I will check whether Entra has a failed attempt for every user.',
      'The proxy shows a failed attempt at each of those times.',
      'Failed attempts at those times were reported by the customer.',
    ],
  },
  {
    id: 'failed row: one for each user, or matching the attempts',
    signal: 'sig.server-side-failure-records-present',
    role: 'support_engineer',
    type: 'diagnostic_result',
    reads: [
      'Each of the three accounts has a failed sign-in row in Entra.',
      'Every one of them has a failure record in SigninLogs.',
      'I can see matching failed sign-in entries for every user.',
      'There are failed sign-in events for all of them.',
      'Matching failure rows were found for every account.',
    ],
    doesNotRead: [
      '0 of 4 failing attempts have a matching record in SigninLogs.',
      'If a failed sign-in row exists for each user, we look at the result codes.',
      'Each of the three accounts will get a failed row if the policy applies.',
    ],
  },
  {
    id: 'failed row: the log lists the failures',
    signal: 'sig.server-side-failure-records-present',
    role: 'support_engineer',
    type: 'diagnostic_result',
    reads: [
      'The sign-in logs list failed attempts for all five users.',
      'Entra recorded blocked sign-ins for every account at those times.',
      'SigninLogs confirms the failures, each with a result code.',
      'The logs contain errors for every one of the users.',
    ],
    doesNotRead: [
      'The sign-in logs do not list any failed attempts for them.',
      'Zero failed rows for any of the accounts at those times.',
    ],
  },
];

function describeFamilies(title: string, families: readonly Family[]): void {
  describe(title, () => {
    for (const family of families) {
      describe(family.id, () => {
        for (const sentence of family.reads) {
          it(`reads: ${sentence}`, () => {
            expect(signalsOf(eventOf(family.role, family.type, sentence))).toContain(family.signal);
          });
        }
        for (const sentence of family.doesNotRead) {
          it(`does not read: ${sentence}`, () => {
            expect(signalsOf(eventOf(family.role, family.type, sentence))).not.toContain(
              family.signal,
            );
          });
        }
      });
    }
  });
}

describeFamilies('wording families of the server side: records in the sign-in log', FAMILIES);

describe('the two sides of the server-side records', () => {
  it('reads a denial of a failed row as the absence of records, not as records', () => {
    const found = signalsOf(
      eventOf('support_engineer', 'diagnostic_result', 'No failed rows exist for these accounts.'),
    );
    expect(found).toContain('sig.no-server-side-failure-records');
    expect(found).not.toContain('sig.server-side-failure-records-present');
  });

  it('does not read a count of nothing as failed rows that are there', () => {
    const found = signalsOf(
      eventOf(
        'support_engineer',
        'escalation_response',
        'There are no failed sign-in requests for those times: 0 of 6 failing attempts have a matching record in SigninLogs.',
      ),
    );
    expect(found).not.toContain('sig.server-side-failure-records-present');
  });

  it('leaves a customer who only repeats what the helpdesk said, and a validation after the fix, alone', () => {
    expect(
      signalsOf(
        eventOf(
          'customer_end_user',
          'customer_email',
          'There are no failed sign-ins in the Entra logs.',
        ),
      ),
    ).not.toContain('sig.no-server-side-failure-records');
    expect(
      signalsOf(
        eventOf(
          'support_engineer',
          'validation_result',
          'Entra shows no failed sign-in rows since the change.',
        ),
      ),
    ).not.toContain('sig.no-server-side-failure-records');
  });
});

const POLICY_AND_TOKEN: readonly Family[] = [
  {
    id: 'policy events outside the failure window',
    signal: 'sig.policy-events-outside-failure-window',
    role: 'support_engineer',
    type: 'query_output',
    reads: [
      'Audit query for conditional access changes, last 14 days: zero rows inside the failure window.',
      'Policy audit for the last 30 days: 6 events, none within the failure window of 08:00 to 09:30 UTC.',
      'Audit log: no policy changes during the reported incident window.',
      'The policy changes in the export all fall outside the failure window.',
      'The only policy event in the audit log is dated in January, so it is unrelated to these failures.',
    ],
    doesNotRead: [
      'Please run an audit query for policy changes inside the failure window.',
      'If the audit shows no policy changes in the failure window, we can rule out conditional access.',
      'I will check whether there were policy changes during the incident window.',
      'Retention policy changes are outside the scope of this case.',
    ],
  },
  {
    id: 'a token or session that ran out, in the words of the log and of the client',
    signal: 'sig.token-expiry-errors',
    role: 'support_engineer',
    type: 'diagnostic_result',
    reads: [
      'The log says AADSTS70043: the refresh token has expired due to a sign-in frequency check.',
      'For the three users the logs show AADSTS50173, the grant has expired.',
      'The refresh token expired because the sign-in frequency was reached.',
      'Their tokens had expired after the long shutdown.',
      'AADSTS700082 appears for every one of them, so this is an inactivity expiry.',
      'A password change ends the existing sessions of the user.',
    ],
    doesNotRead: [
      'The token has not expired yet.',
      'I do not think this is an expired token.',
      'It could be an expired token, but the logs are not conclusive.',
      'Please check whether the refresh token has expired.',
      'If the session expired we would see AADSTS700082 in the logs.',
      'We revoked all refresh tokens for the group at 08:35 UTC.',
      'The token-signing certificate expired yesterday.',
    ],
  },
  {
    id: 'a customer who reads out the message of the client',
    signal: 'sig.token-expiry-errors',
    role: 'customer_end_user',
    type: 'customer_email',
    reads: [
      'The Teams window says your session has expired, please sign in again.',
      'On the shared tablets the message is session expired and then the login screen.',
    ],
    doesNotRead: ['The meeting invitation has expired.', 'My password expires next week.'],
  },
  {
    id: 'Conditional Access or MFA that stopped a sign-in, as the log shows it',
    signal: 'sig.mfa-ca-events-in-logs',
    role: 'support_engineer',
    type: 'diagnostic_result',
    reads: [
      'Each blocked sign-in shows AADSTS53003 in the Entra logs.',
      'Found it: the CA policy Block unmanaged devices is blocking them.',
      'Their rows still show the policy applied and blocked.',
      'For the failing attempts the result was interrupted because multi-factor is required.',
      'Every attempt has a Conditional Access result of failure.',
      'The sign-ins were denied by the new conditional access policy and one shows an interrupted MFA step.',
    ],
    doesNotRead: [
      'Conditional Access is a feature of the tenant.',
      'We will review whether the CA policy blocked them.',
      'If the conditional access policy is blocking them we should see 53003.',
      'No Conditional Access or MFA results for these attempts.',
      'A new policy that blocks sign-ins from outside the country was rolled out yesterday.',
    ],
  },
];

describeFamilies(
  'wording families of the server side: policy window, tokens, Conditional Access',
  POLICY_AND_TOKEN,
);
