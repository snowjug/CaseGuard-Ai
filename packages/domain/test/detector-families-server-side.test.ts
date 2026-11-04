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

const NETWORK: readonly Family[] = [
  {
    id: 'one name server fails: a code next to an address, or a name server that fails, times out or drops the queries',
    signal: 'sig.resolver-inconsistent',
    role: 'support_engineer',
    type: 'diagnostic_result',
    reads: [
      'Pointed Resolve-DnsName at both servers: 10.5.0.2 answers instantly, 10.5.0.3 returns SERVFAIL for the sign-in host.',
      'dns2 keeps failing for the Microsoft sign-in names; dns1 answers.',
      'The second name server times out for the CDN host most of the time.',
      'One of the three DNS servers in Brno does not answer for the sign-in hosts.',
      'nslookup against 192.168.7.53 gives NXDOMAIN for aadcdn.msauth.net, 192.168.7.54 answers correctly.',
      'Resolver 10.1.2.3 drops queries for the Microsoft hosts.',
      '10.20.30.41: 8 of 10 lookups came back SERVFAIL.',
      'DNS server 172.16.4.11 returned no answer for the sign-in host in 6 of 10 tests.',
      'The Dublin resolver at 10.2.2.2 is intermittently timing out on the CDN host.',
      'We see SERVFAIL responses coming from 10.3.3.3 for the CDN host.',
      'One of the two DNS servers returns the wrong address for the sign-in host.',
      'The secondary DNS server is unreachable from the branch.',
      'Both Gdansk DNS servers forward to a datacentre resolver, and that resolver fails for the sign-in names at times.',
    ],
    doesNotRead: [
      'Please run nslookup against 10.5.0.3 and tell me whether it returns SERVFAIL.',
      'If the resolver returns SERVFAIL we remove it from the scope.',
      '10.5.0.3 fails over to 10.5.0.2 when the primary is busy.',
      'The proxy at 10.5.0.9 times out for the sign-in hosts.',
      'I suspect the resolver is returning SERVFAIL.',
      'DNS is less likely given the timeout code.',
      'The label printer cannot resolve its print server name.',
    ],
  },
  {
    id: 'one name server fails: a filter that blocks the sign-in names, and the network administrator who tested it',
    signal: 'sig.resolver-inconsistent',
    role: 'customer_network_admin',
    type: 'customer_email',
    reads: [
      'Our secondary resolver .14 refuses queries for login.microsoftonline.com about half the time.',
      'From a Tallinn laptop: 10.9.0.2 answers all hosts, 10.9.0.3 returns NXDOMAIN for the CDN names.',
      'The DNS filtering service sinkholes the CDN host that Teams needs.',
    ],
    doesNotRead: [
      'My colleague thinks the resolver might return SERVFAIL.',
      'We will test each resolver for SERVFAIL tomorrow.',
    ],
  },
  {
    id: 'one name server fails: the helpdesk that only passes on what it was told',
    signal: 'sig.resolver-inconsistent',
    role: 'customer_admin',
    type: 'customer_email',
    reads: [],
    doesNotRead: [
      'The network team told us that 10.5.0.3 returns SERVFAIL for the sign-in names.',
      'Our helpdesk says dns2 times out for the CDN host.',
    ],
  },
  {
    id: 'every name server answers: all of them, both of them, "DNS is fine", no DNS problems',
    signal: 'sig.resolvers-consistent',
    role: 'support_engineer',
    type: 'diagnostic_result',
    reads: [
      'I asked all three resolvers for the sign-in host ten times; every resolver answered correctly each time.',
      'Both DNS servers answer the sign-in and CDN hosts normally.',
      'All 4 name servers respond fine for the Microsoft hosts.',
      'DNS is fine: every lookup returned the right address.',
      'Name resolution looks healthy on every server we tested.',
      'No DNS problems found on any resolver.',
      'Queried each resolver in turn. All three answered every time, within a few milliseconds.',
      'None of the resolvers returned SERVFAIL for the sign-in hosts.',
      'Resolver 10.5.0.3 does not time out for the sign-in host.',
      'All three DNS servers returned the right address for the sign-in hosts.',
      'DNS checks out.',
      'No SERVFAIL or NXDOMAIN from any resolver.',
      'Resolve-DnsName succeeded on both resolvers for 200 consecutive queries.',
    ],
    doesNotRead: [
      'Please check that all three resolvers answer normally.',
      'If all resolvers answer fine, DNS is ruled out.',
      'One resolver answers normally, the other one times out.',
      'All proxy nodes respond normally.',
      'DNS is less likely given the timeout code.',
      'All the resolvers answer normally except 10.5.0.3, which returns SERVFAIL.',
      'I will test whether every resolver answers within a second.',
    ],
  },
  {
    id: 'every name server answers: the network administrator after the fix, and a dashboard that is not a test',
    signal: 'sig.resolvers-consistent',
    role: 'customer_network_admin',
    type: 'customer_email',
    reads: [
      'From a Riga PC: every resolver answers the sign-in hosts, ten of ten queries each.',
      'Both resolvers answered all 200 queries normally after the change.',
    ],
    doesNotRead: [
      'The monitoring page is green for both resolvers.',
      'I am fairly sure all the DNS servers are healthy.',
    ],
  },
  {
    id: 'one proxy node does not answer: its name next to a timeout, a drop or a hang',
    signal: 'sig.proxy-node-inconsistent',
    role: 'support_engineer',
    type: 'diagnostic_result',
    reads: [
      'pxy-ams-03 timed out on every request while the other nodes answered in under a second.',
      'One proxy server out of four drops the connection to login.microsoftonline.com.',
      'Through the Utrecht proxies one by one: utr-prx1 and utr-prx2 fine, utr-prx3 timing out.',
      'The second proxy node times out for the sign-in addresses, the first and third are fine.',
      'Of the four proxy nodes, node 2 returns a gateway timeout.',
      'From a branch PC: proxy-a answers in 0.4 s, proxy-b hangs.',
      'wsg-02 is not responding for the sign-in hosts.',
      'proxy-c: 7 of 10 timed out. proxy-b: 10 of 10 fine.',
      'Node 3 of the proxy cluster returns 502 for the sign-in host.',
      'One of the proxies is overloaded and drops sign-in requests.',
    ],
    doesNotRead: [
      'Please test whether proxy-04 times out.',
      'If proxy-04 times out again we will take it out of the pool.',
      'The proxy dashboard shows all nodes green.',
      'Teams times out at sign-in for people in Oslo.',
      'I suspect one proxy node is timing out.',
      'All three proxy nodes answered within a second.',
    ],
  },
  {
    id: 'one proxy node does not answer: the network administrator, and the recap of a closed case',
    signal: 'sig.proxy-node-inconsistent',
    role: 'customer_network_admin',
    type: 'customer_email',
    reads: [
      'proxy node 3 times out for the Microsoft sign-in hosts.',
      'Tested all the proxies from Oslo: osl-prx2 times out one in three times.',
    ],
    doesNotRead: ['We have two proxies in Oslo and I am sure that both are healthy.'],
  },
  {
    id: 'every proxy node answers: all of them, none timed out, no timeouts',
    signal: 'sig.proxy-nodes-consistent',
    role: 'support_engineer',
    type: 'diagnostic_result',
    reads: [
      'All three proxy nodes answered the sign-in hosts within a second, five of five times each.',
      'Every proxy responds normally now.',
      'None of the proxies timed out in the test.',
      'No timeouts through any of the proxy nodes.',
      'The proxy test: all four nodes answered normally.',
      'All proxy nodes responded without a timeout after the change.',
      '100 requests through each of the three proxy nodes completed without a timeout.',
    ],
    doesNotRead: [
      'Please check that all proxy nodes respond normally.',
      'pxy-03 timed out while all the other proxies answered normally.',
      'All resolvers answer normally.',
      'If every proxy answers fine, the proxy pool is ruled out.',
      'The proxy dashboard shows all nodes green.',
    ],
  },
  {
    id: 'every proxy node answers: the helpdesk that only passes on what it was told',
    signal: 'sig.proxy-nodes-consistent',
    role: 'customer_admin',
    type: 'customer_email',
    reads: [],
    doesNotRead: ['The network team says all four proxy nodes answer fine.'],
  },
];

describeFamilies('wording families of the server side: name servers and proxy nodes', NETWORK);

describe('the pairs of the name servers and the proxy nodes', () => {
  it('reads a denial of a failure as the other side, and says which signal it denied', () => {
    const found = observationsOf(
      eventOf(
        'support_engineer',
        'diagnostic_result',
        'None of the resolvers failed for the sign-in hosts.',
      ),
    );
    const consistent = found.find((o) => o.signalId === 'sig.resolvers-consistent');
    expect(consistent?.negationOf).toBe('sig.resolver-inconsistent');
    expect(found.map((o) => o.signalId)).not.toContain('sig.resolver-inconsistent');
  });

  it('does not read a subject line that repeats an earlier one', () => {
    const event = { ...eventOf('support_engineer', 'engineer_email', 'Closing the case.') };
    expect(
      signalsOf({ ...event, title: 'Re: One DNS server is failing for the sign-in names' }),
    ).not.toContain('sig.resolver-inconsistent');
    expect(
      signalsOf({ ...event, title: 'One DNS server is failing for the sign-in names' }),
    ).toContain('sig.resolver-inconsistent');
  });
});
