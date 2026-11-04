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
      'The sign-in log for those accounts turned up nothing at all in that hour.',
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
      'Anything routed via proxy node 3 hangs when it heads for the Microsoft login endpoints.',
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

const CHANGES: readonly Family[] = [
  {
    id: 'a network change told by the customer: what was moved, replaced, upgraded or enabled, and when',
    signal: 'sig.recent-network-change-reported',
    role: 'customer_network_admin',
    type: 'customer_email',
    reads: [
      'We upgraded the firewall firmware on Friday night.',
      'The proxy vendor pushed an update on Tuesday morning.',
      'Our ISP changed the public IP range of the Leeds site last weekend.',
      'We migrated the proxies to a new cluster two days ago.',
      'A new web filtering category was enabled on the gateway yesterday evening.',
      'Someone replaced the DNS forwarders on Sunday.',
      'On Thursday we switched to a different VPN provider.',
      'The PAC file was changed on Monday and clients picked it up overnight.',
      'Node 2 got a renewed TLS inspection certificate last Tuesday.',
      'Last week our security team turned on a new filtering rule for the DNS resolvers.',
    ],
    doesNotRead: [
      'Resolver 10.4.0.5 was removed from the DHCP scopes at 12:40 UTC and clients are renewing leases.',
      'The PAC file was updated at 11:35 UTC and proxy-3 is out of rotation.',
      'We will upgrade the firewall firmware on Friday night.',
      'Nothing has changed on the proxies in the last week.',
      'We did not touch the DNS servers this week.',
      'I think someone touched the proxy at some point, but I do not know when.',
      'The firewall change is planned for next Tuesday.',
      'The network team changed the meeting room schedule yesterday.',
      'We deployed the DNS exception for the Microsoft endpoints and added the resolver back to DHCP.',
    ],
  },
  {
    id: 'a network change that the customer passes on, and one an engineer asks about',
    signal: 'sig.recent-network-change-reported',
    role: 'customer_end_user',
    type: 'customer_email',
    reads: ['The IT team said they moved the DNS to a new rack on Monday.'],
    doesNotRead: ['Please ask the network team whether they upgraded the firewall last night.'],
  },
  {
    id: 'a change to the access policy told by the customer: a policy that requires MFA rolled out, the sign-in frequency set',
    signal: 'sig.recent-ca-change-reported',
    role: 'customer_admin',
    type: 'customer_email',
    reads: [
      'Yesterday afternoon our identity team rolled out a policy that blocks sign-ins from outside the country.',
      'On Wednesday I lowered the sign-in frequency to two hours.',
      'Last week we enabled a policy that requires MFA for every cloud app.',
      'Two days ago somebody changed the session lifetime for Teams.',
    ],
    doesNotRead: [
      'We will roll out a policy that requires MFA next month.',
      'Our compliance officer changed the retention policy yesterday.',
      'Could it be that the policy that requires MFA was rolled out on Monday?',
      'The password policy was changed yesterday.',
    ],
  },
  {
    id: 'a change to the access policy read by the engineer in the audit log or the recap',
    signal: 'sig.recent-ca-change-reported',
    role: 'support_engineer',
    type: 'diagnostic_result',
    reads: [
      'The audit log shows the policy Mobile access updated on Tuesday at 09:15 UTC.',
      'A new Conditional Access policy was assigned to the whole sales group instead of the pilot group.',
    ],
    doesNotRead: [
      'Please check the audit log for policy changes from yesterday.',
      'The audit log shows no policy changes.',
    ],
  },
  {
    id: 'the access policy left alone: not changed, not touched, unchanged, only old events',
    signal: 'sig.ca-config-unchanged',
    role: 'customer_admin',
    type: 'customer_email',
    reads: [
      'Conditional Access has not been touched since January.',
      'Our CA policies were not modified by anyone this quarter.',
      'Nobody changed the access rules before the problems started.',
      'The session policy remains unchanged.',
      'The sign-in frequency is still the same as before.',
      'The only policy events in the audit log are dated in February, so nothing recent changed.',
    ],
    doesNotRead: [
      'Conditional Access was changed yesterday.',
      'The marketing team has not been told about the conditional access change.',
      'Please check whether the access policies were modified.',
      'The printer policy is unchanged.',
    ],
  },
  {
    id: 'leaving users out of the policy changed nothing',
    signal: 'sig.ca-exclusion-no-effect',
    role: 'customer_admin',
    type: 'customer_email',
    reads: [
      'We excluded the five affected users from the MFA policy and they are still blocked.',
      'The security team left out the whole sales group. People kept getting the same error afterwards.',
      'I exempted two accounts from the policy and it made no difference.',
      'Excluded the pilot group from the rule at 10:15 UTC: still blocked, same message.',
    ],
    doesNotRead: [
      'We excluded the five affected users from the MFA policy and they can sign in now.',
      'Should we exclude the five users from the MFA policy, or would they still be blocked?',
      'We will exclude the pilot group tomorrow.',
      'If we excluded the group, the failures might continue.',
      'We excluded the Oslo proxy from TLS inspection and it is still timing out.',
    ],
  },
  {
    id: 'an exclusion that is in place, and the users are still blocked: the engineer reads the rows',
    signal: 'sig.ca-exclusion-no-effect',
    role: 'support_engineer',
    type: 'diagnostic_result',
    reads: [
      'The exclusion is on the group Contractors, but the users are in the group Vendors, so their rows still show the policy applied.',
    ],
    doesNotRead: ['Please add the exclusion for the users.'],
  },
];

describeFamilies('wording families of the server side: what changed in the policy', CHANGES);

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

const DEVICE_AND_SERVICE: readonly Family[] = [
  {
    id: 'the device has its token: AzureAdPrt YES, or a valid token in words, or one device with and one without',
    signal: 'sig.prt-healthy',
    role: 'support_engineer',
    type: 'diagnostic_result',
    reads: [
      'dsregcmd /status on the repaired laptop: AzureAdPrt : YES, and Teams signs in.',
      'AzureAdPrt YES for both pilot users.',
      'The old laptop has a valid PRT; the new one does not.',
      'The primary refresh token is available on all five machines.',
      'PRT status looks fine on the device.',
      'The device is hybrid joined and has PRT.',
      'Good news: the primary refresh token is there and was issued at 08:12.',
      'The new tablet shows no PRT, but the one it replaced does.',
    ],
    doesNotRead: [
      'Neither workstation in the pilot group received a primary refresh token.',
      'dsregcmd output for the repaired desktop: AzureAdPrt = NO.',
      'Please check whether the laptop has a valid PRT.',
      'If the PRT is healthy, we can rule out the device.',
      'The device has a PRT but it is expired.',
      'The PRT is not present on this laptop.',
      'We cannot confirm that the laptop has a PRT without the dsregcmd output.',
    ],
  },
  {
    id: 'the device has lost its token: AzureAdPrt NO, no token in words, one device without',
    signal: 'sig.prt-missing',
    role: 'support_engineer',
    type: 'diagnostic_result',
    reads: [
      'The laptop has lost its primary refresh token.',
      'dsregcmd shows AzureAdPrt is NO on the sick laptop.',
      'These devices never got a PRT after the re-image.',
      'AzureAdPrt NO on three of the four laptops.',
      "The spare tablet got a PRT; the one on the shelf doesn't.",
      "The PRT can't be refreshed by the broker.",
      'The primary refresh token could not be obtained.',
      "The laptop doesn't get a primary refresh token anymore.",
    ],
    doesNotRead: [
      'The device has a primary refresh token.',
      'AzureAdPrt : YES on this laptop.',
      'Please check whether the laptop lost its PRT.',
      'If the PRT is missing we re-register the device.',
      'I suspect the laptop lost its primary refresh token.',
      "The laptop has a PRT, but it doesn't help with the Teams error.",
      "If the PRT can't be obtained we will rejoin the device.",
      'Please check that the primary refresh token can be obtained.',
    ],
  },
  {
    id: 'the token state pasted by the customer: AzureAdPrt NO',
    signal: 'sig.prt-missing',
    role: 'customer_end_user',
    type: 'customer_email',
    reads: ['I ran dsregcmd /status as asked and it prints AzureAdPrt : NO.'],
    doesNotRead: ['I will run dsregcmd /status tomorrow and send AzureAdPrt : NO or YES.'],
  },
  {
    id: 'a federation server in error: a certificate that expired, a clock that is off, tokens refused, a node that is down',
    signal: 'sig.federation-node-error',
    role: 'support_engineer',
    type: 'diagnostic_result',
    reads: [
      'The token-signing certificate on ADFSPROD01 expired yesterday at 23:59 UTC.',
      'ADFS02 has a signing certificate that expired last night.',
      'The clock of ADFS02 runs 4 minutes slow, so its tokens are rejected.',
      'The AD FS server clock is five minutes ahead of the domain controller.',
      'Tokens issued by the federation farm are rejected as not yet valid.',
      'Several ADFS nodes return HTTP 500.',
      'The AD FS service on node 2 stopped responding.',
      'Event 364 on the federation server: the token signing certificate is no longer valid.',
      'ADFS clock skew of about two minutes on one node.',
    ],
    doesNotRead: [
      'Please check the token-signing certificate on the AD FS farm.',
      'If the federation server clock is off, tokens would be rejected.',
      'I suspect the ADFS node is down.',
      "The customer's ADFS is probably not involved.",
      'The TLS inspection certificate on the proxy expired last week.',
      'The renewal of the token-signing certificate is planned for Friday, before it expires.',
    ],
  },
  {
    id: 'a federation server in error, as the engineer asks or says it in a mail',
    signal: 'sig.federation-node-error',
    role: 'support_engineer',
    type: 'engineer_email',
    reads: ['We found the AD FS node ADFS03 down since 08:05, so a third of the sign-ins fail.'],
    doesNotRead: [
      'Since you use AD FS, could you look at the certificates, the system time and the AD FS event log around the failed attempts?',
      'ADFS failed over to the second node without any user impact.',
    ],
  },
  {
    id: 'a federation server in error, told by the customer administrator who looked',
    signal: 'sig.federation-node-error',
    role: 'customer_admin',
    type: 'customer_email',
    reads: ['Our AD FS node in the DMZ is down since this morning.'],
    doesNotRead: ['The AD FS team is in a meeting until noon.'],
  },
  {
    id: 'Microsoft has an incident that matches: posted, confirmed, listed, open',
    signal: 'sig.service-health-incident',
    role: 'support_engineer',
    type: 'engineer_email',
    reads: [
      'Service health at 10:40 UTC: Microsoft has posted an incident for Teams and sign-in in Europe.',
      'Microsoft confirms the outage affecting Teams sign-in and says mitigation is under way.',
      'The incident explains the timeouts, there is nothing to change on your side.',
      'The Microsoft status page lists an active advisory for Entra sign-in.',
      'The incident stays open while Microsoft rolls out the fix.',
      'There is an incident for Teams and authentication in the West Europe region.',
    ],
    doesNotRead: [
      'Please check whether Microsoft has posted an incident for Teams.',
      'If the incident explains the failures we will tell you.',
      'Maybe it is a Microsoft outage affecting sign-in.',
      'I will check service health for an incident later.',
      'Service health shows no incident for Teams.',
    ],
  },
  {
    id: 'an incident that the customer heard about from someone else',
    signal: 'sig.service-health-incident',
    role: 'customer_end_user',
    type: 'customer_email',
    reads: [],
    doesNotRead: ['The office manager says the status page showed an incident for Teams.'],
  },
  {
    id: 'Microsoft has no incident: service health clear, nothing active, not an outage',
    signal: 'sig.service-health-clear',
    role: 'support_engineer',
    type: 'engineer_email',
    reads: [
      'The service health page is all green for our tenant right now.',
      'Looked at the message center and service health: nothing active for sign-in.',
      'The Microsoft status page shows no incident for Teams, so this is not an outage.',
      'No active incident for Teams or Entra sign-in right now.',
      'Service health does not show any incident or advisory.',
      'This is not a Microsoft outage; the status page is green.',
    ],
    doesNotRead: [
      'Please check that service health is clear.',
      'If service health is clear we look at the proxy.',
      'Microsoft has posted an incident for Teams.',
      'I do not think this is a Microsoft outage.',
      'The status page is red for Teams in Europe.',
    ],
  },
  {
    id: 'a closing note that lists the theories that were rejected',
    signal: 'sig.service-health-clear',
    role: 'support_engineer',
    type: 'resolution_note',
    reads: [],
    doesNotRead: [
      'None of the theories held: not an expired token, not a service incident, not a device fault.',
    ],
  },
  {
    id: 'a dashboard colour that the customer heard about',
    signal: 'sig.service-health-clear',
    role: 'customer_end_user',
    type: 'customer_email',
    reads: [],
    doesNotRead: ['Our helpdesk says the Microsoft status page is green.'],
  },
];

describeFamilies(
  'wording families of the server side: devices, federation and service health',
  DEVICE_AND_SERVICE,
);

const WIDER: readonly Family[] = [
  {
    id: 'no failed row, counted: "0 failures", "returned 0 records"',
    signal: 'sig.no-server-side-failure-records',
    role: 'support_engineer',
    type: 'diagnostic_result',
    reads: [
      'Both sign-in log tables show 0 failures for the three accounts in that window.',
      'The query against SigninLogs returned 0 records for those UPNs.',
    ],
    doesNotRead: [
      'Please tell me whether SigninLogs returns 0 records for those UPNs.',
      'If both sign-in log tables show 0 failures we can close the identity side.',
    ],
  },
  {
    id: 'failed rows that are there, said another way: a count, "I can see each of the failures", "show up as failures", one row per attempt',
    signal: 'sig.server-side-failure-records-present',
    role: 'support_engineer',
    type: 'diagnostic_result',
    reads: [
      'SigninLogs holds 7 failed rows for the affected UPNs, all with result code 53003.',
      'I can see each of the failures in Entra, one row per attempt.',
      'We see the attempts on our side; they show up as failures with error 530032.',
      'Found 12 failed sign-ins for that user between 14:00 and 14:30 UTC.',
    ],
    doesNotRead: [
      'Please confirm that you can see each of the failures in Entra.',
      'SigninLogs holds 0 failed rows for the affected UPNs.',
      'If I find 12 failed sign-ins for that user I will send them to you.',
    ],
  },
  {
    id: 'one name server fails, called another way: "the secondary DNS", "ns2", "resolver B", an address that fails for a host or for a share of the tries',
    signal: 'sig.resolver-inconsistent',
    role: 'support_engineer',
    type: 'diagnostic_result',
    reads: [
      "nslookup against the secondary DNS gives 'server failed' for the sign-in hostnames; the primary resolves them.",
      'Resolver B drops about a third of the queries for the Microsoft sign-in names.',
      'ns2 returns an empty answer for login.microsoftonline.com while ns1 returns the right address.',
      'The DNS server at 10.40.0.9 is filtering the Microsoft hostnames and returns 0.0.0.0.',
      '10.7.0.5 failed for login.microsoftonline.com in 4 of 10 tries.',
    ],
    doesNotRead: [
      'Please test the secondary DNS for the sign-in hostnames.',
      'If ns2 drops queries we will take it out of the DHCP scope.',
      'Both resolvers returned the right address for login.microsoftonline.com.',
    ],
  },
  {
    id: 'every name server answers, said another way: "the same addresses", "no difference between the resolvers", "works on every DNS server"',
    signal: 'sig.resolvers-consistent',
    role: 'support_engineer',
    type: 'diagnostic_result',
    reads: [
      'Both DNS servers resolve login.microsoftonline.com to the same addresses.',
      'I tested all three resolvers for the sign-in hostnames and every one answered in under 40 ms.',
      'nslookup against 10.0.0.2 and 10.0.0.3 returns identical, correct answers.',
      'There is no difference between the resolvers; each returns the correct IPs.',
      'Resolution of the sign-in hosts works on every DNS server we tried.',
      'The two forwarders return the same result for teams.microsoft.com every time.',
    ],
    doesNotRead: [
      'Please check that all resolvers answer.',
      'One resolver fails for login.microsoftonline.com.',
    ],
  },
  {
    id: 'one proxy node fails, called another way: "PRX-B", "one of the four proxy nodes", "only the Oslo proxy", an address, "one bad node"',
    signal: 'sig.proxy-node-inconsistent',
    role: 'support_engineer',
    type: 'diagnostic_result',
    reads: [
      'One of the four proxy nodes, PRX-B, hangs on connections to login.microsoftonline.com.',
      'Only the Oslo proxy drops the traffic to Teams; the other proxy servers are fine.',
      'The proxy at 10.1.9.14 fails to forward requests; 10.1.9.12 and .13 are okay.',
      'One proxy out of three is dropping the connections to the Microsoft login endpoints.',
      'Our proxy farm has one bad node that times out on TLS handshakes.',
    ],
    doesNotRead: ['Please test each proxy node.', 'All proxies answer normally.'],
  },
  {
    id: 'every proxy node answers, said another way: "none of them timed out", "returned 200", "behaving the same", "no bad node"',
    signal: 'sig.proxy-nodes-consistent',
    role: 'support_engineer',
    type: 'diagnostic_result',
    reads: [
      'We tested each proxy server and none of them timed out.',
      'Every proxy returned 200 for login.microsoftonline.com.',
      'The proxies are behaving the same; there is no bad node.',
      'Requests through proxy-01, proxy-02 and proxy-03 all succeeded without errors.',
      'All proxy nodes pass the connectivity test to the sign-in endpoint.',
    ],
    doesNotRead: ['Please confirm that all proxy nodes respond.', 'One proxy node times out.'],
  },
  {
    id: 'a federation node in error, said another way: an HTTP 5xx, the time skew named first',
    signal: 'sig.federation-node-error',
    role: 'support_engineer',
    type: 'diagnostic_result',
    reads: [
      'One AD FS node is returning HTTP 503 for the sign-in requests.',
      'Time skew of 7 minutes on the STS node.',
    ],
    doesNotRead: ['Please measure the time skew on the STS node.'],
  },
];

describeFamilies('wording families of the server side: the same facts, said another way', WIDER);

describe('the pairs of the device token and the service health', () => {
  it('reads a denial of an incident as the clear side, and says which signal it denied', () => {
    const found = observationsOf(
      eventOf(
        'support_engineer',
        'engineer_email',
        'Microsoft has not posted an incident for Teams.',
      ),
    );
    const clear = found.find((o) => o.signalId === 'sig.service-health-clear');
    expect(clear?.negationOf).toBe('sig.service-health-incident');
    expect(found.map((o) => o.signalId)).not.toContain('sig.service-health-incident');
  });

  it('reads a token that is there and one that is not, from the one sentence', () => {
    const found = signalsOf(
      eventOf(
        'support_engineer',
        'diagnostic_result',
        "The spare tablet got a PRT; the one on the shelf doesn't.",
      ),
    );
    expect(found).toContain('sig.prt-healthy');
    expect(found).toContain('sig.prt-missing');
  });

  it('leaves the recap of a case note to the older detectors', () => {
    expect(
      signalsOf(
        eventOf('support_engineer', 'case_note', 'The PRT is present on all three devices.'),
      ),
    ).not.toContain('sig.prt-healthy');
  });
});

const PRECISION: readonly Family[] = [
  {
    id: 'no failed row: a time range called the failure window is not a failure, and "nothing is known yet" is not an empty log',
    signal: 'sig.no-server-side-failure-records',
    role: 'support_engineer',
    type: 'diagnostic_result',
    reads: [
      'I went through the sign-in logs for those users. There is nothing at all for the failing attempts.',
      'Zero rows for the failing attempts between 09:00 and 09:30.',
    ],
    doesNotRead: [
      'The audit query came back with zero rows inside the failure window.',
      'We got 0 rows in the incident period for the failure window you gave.',
      'A bad token or a Conditional Access block would show in the sign-in logs, so I will check those first. Nothing is certain yet.',
      'The sign-in logs will tell us more. For now nothing is decided.',
    ],
  },
  {
    id: 'several people: a count of people is read when they are affected, not when they are the object of an administrator or have only replied',
    signal: 'sig.multiple-users-affected',
    role: 'customer_admin',
    type: 'customer_email',
    reads: [
      'More than 40 users in the Leeds office cannot sign in to Teams since nine.',
      'Several people on the second floor get the same error.',
      'We asked around and 25 colleagues have the same problem.',
      'The policy blocked 50 users this morning.',
    ],
    doesNotRead: [
      'I disabled the accounts of 60 users last night and asked them to sign in again.',
      'Our helpdesk forced a password change for 300 users on Friday.',
      '35 people have replied that the error is gone.',
      'Twenty minutes ago I checked the list: 40 people from the Oslo team are in that group. They are not affected.',
    ],
  },
];

describeFamilies(
  'wording families of the server side: precision of two older detectors',
  PRECISION,
);

const SCOPE_WORDING: readonly Family[] = [
  {
    id: 'site-correlated: a named group at a place, a limit to a place, the others fine',
    signal: 'sig.site-correlated',
    role: 'customer_admin',
    type: 'customer_email',
    reads: [
      'Everybody at the Wroclaw branch hits the error since eight; Opole and Katowice behave normally.',
      'The trouble is confined to the Antwerp warehouse.',
      'This only happens in the Bremen plant.',
      'All failing accounts sit in the Gothenburg office.',
      'Errors are reported mostly at the Cluj depot and rarely anywhere else.',
      'Nobody at any other location has written in about it.',
      'From the Valencia office it fails, but at home it works.',
      'Porto office is down for sign-in, and the rest of the group has no trouble.',
    ],
    doesNotRead: [
      'Users at every one of our offices see this error.',
      'The label printer in the Oslo office jammed.',
      'Just one user in the Oslo office has the problem.',
      'We have offices in Oslo, Bergen and Trondheim.',
      'Please tell me which sites are affected.',
      'If only the Berlin office were affected we would blame the network.',
      'Everyone in the company is affected, all sites.',
    ],
  },
  {
    id: 'web client: the browser version fails as well',
    signal: 'sig.web-client-also-fails',
    role: 'customer_end_user',
    type: 'customer_email',
    reads: [
      "Teams in the browser doesn't work either.",
      'In Safari we get the same screen as in the app.',
      'Both the app and the web client fail for us.',
      'It fails in the browser too.',
      'On teams.microsoft.com too it is exactly the same behaviour.',
      'Through the web page we receive the identical message.',
    ],
    doesNotRead: [
      'The web client works fine for everyone.',
      'Please try the browser version of Teams.',
      'Does the web version fail as well?',
      'Our intranet web portal is slow today.',
      'If the browser version fails too, we will call you.',
    ],
  },
  {
    id: 'name not found, in the words of a browser',
    signal: 'sig.error-name-not-resolved',
    role: 'customer_end_user',
    type: 'customer_email',
    reads: ['The browser tells her the server address could not be found.'],
    doesNotRead: ['The server address will be sent to you by the network team.'],
  },
  {
    id: 'name servers: every one answers, said another way',
    signal: 'sig.resolvers-consistent',
    role: 'support_engineer',
    type: 'diagnostic_result',
    reads: [
      'DNS resolution is healthy on the three resolvers we probed.',
      'Resolvers 10.7.0.1, 10.7.0.2 and 10.7.0.3 respond identically for the sign-in hosts.',
      'All name servers answered every lookup during the test.',
      'The primary and the secondary DNS both return the right address.',
    ],
    doesNotRead: [
      'Please check that all resolvers answer.',
      'DNS resolution is broken on the secondary server.',
      'The secondary DNS and the primary both returned an empty answer.',
    ],
  },
];

describeFamilies('wording families of the server side: scope and what was tried', SCOPE_WORDING);
