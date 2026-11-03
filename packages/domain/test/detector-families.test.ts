import { describe, expect, it } from 'vitest';
import type { CaseEvent, EventType, ParticipantRole } from '@caseguard/schemas';
import { createFullView, detectObservations, getCompiledPack } from '../src';

/**
 * One reusable way of saying a thing, one family of the wording families added in wave 2 (docs/MISS_TAXONOMY.md). For each
 * signal: sentences the detectors must read, and look-alikes they must not. The sentences are written for this test, not
 * taken from the evaluation cases, so passing here does not depend on those cases.
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

const signalsOf = (event: CaseEvent): string[] =>
  detectObservations(createFullView([event], null), pack, 'case_fam').map((o) => o.signalId);

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
    id: 'F01 intermittency',
    signal: 'sig.intermittent-failures',
    role: 'customer_end_user',
    type: 'customer_email',
    reads: [
      'It works on and off through the day.',
      'Occasionally the login goes through on the second try.',
      'The problem comes and goes; some mornings it is fine.',
      'From time to time it fails and then works again.',
      'It is not constant, it shows up a few times each hour.',
      'Randomly we get thrown out.',
      'If you retry it sometimes goes through.',
    ],
    doesNotRead: [
      'Sometimes I forget my password.',
      'This is not intermittent, it always fails.',
      'We will check whether it is intermittent.',
      'If it turns out to be intermittent we will tell you.',
    ],
  },
  {
    id: 'F02 other sites are fine',
    signal: 'sig.site-correlated',
    role: 'customer_admin',
    type: 'customer_email',
    reads: [
      'Users at our Zlin office have no trouble.',
      'The Zlin colleagues are fine.',
      'Staff in the Brno branch have no problems at all.',
      'Other offices are fine.',
    ],
    doesNotRead: [
      'Everyone at our office is affected.',
      'The office is fine with the new policy.',
      'The team is fine with the plan.',
    ],
  },
  {
    id: 'F03 name resolution in words',
    signal: 'sig.error-name-not-resolved',
    role: 'customer_end_user',
    type: 'customer_email',
    reads: [
      'Teams shows that the host name could not be resolved.',
      'When users sign in the name of the server cannot be resolved.',
      'The sign-in window says the name was not resolved.',
    ],
    doesNotRead: [
      'The print server name could not be resolved.',
      'The label printer says the name of the server could not be resolved.',
      'Teams works fine for everybody.',
    ],
  },
  {
    id: 'F04 no records in the logs',
    signal: 'sig.no-server-side-failure-records',
    role: 'support_engineer',
    type: 'diagnostic_result',
    reads: [
      'Checked the sign-in logs for the three users. There were no matching records for those attempts.',
      'No failures were logged for any of the users.',
      'Looked through the Entra sign-in logs. Nothing there for those users.',
      'The requests never made it to Entra.',
      'No failure rows for the times they reported.',
    ],
    doesNotRead: [
      'Please check whether there are no records in the logs.',
      'We expect there will be no records for them.',
      'If there are no records in the logs, escalate.',
      'The logs show errors for all of them.',
    ],
  },
  {
    id: 'F13 log findings in prose',
    signal: 'sig.server-side-failure-records-present',
    role: 'support_engineer',
    type: 'diagnostic_result',
    reads: [
      'All the failed attempts are in the Entra sign-in logs.',
      'The sign-in logs show errors at the times they were signed out.',
      'The logs list failures for each of the three users.',
    ],
    doesNotRead: [
      'The logs do not show any failures.',
      'Please look in the logs for failures.',
      'Nothing is recorded in the logs.',
    ],
  },
  {
    id: 'F13 stopped by conditional access',
    signal: 'sig.mfa-ca-events-in-logs',
    role: 'support_engineer',
    type: 'diagnostic_result',
    reads: [
      'Every failed attempt was stopped by Conditional Access.',
      'The sign-in was blocked because of Conditional Access.',
      'One of them shows an interrupted multi-factor step.',
    ],
    doesNotRead: [
      'Conditional Access is a feature of the tenant.',
      'We will review whether Conditional Access blocked them.',
    ],
  },
  {
    id: 'F13 token expiry in prose',
    signal: 'sig.token-expiry-errors',
    role: 'support_engineer',
    type: 'diagnostic_result',
    reads: [
      'The logs show errors 70043 and 700082 for these users.',
      'The log says the token has expired.',
    ],
    doesNotRead: ['Error 4040 was returned by the portal.', 'The token has not expired yet.'],
  },
  {
    id: 'F05 a name server does not answer',
    signal: 'sig.resolver-inconsistent',
    role: 'support_engineer',
    type: 'diagnostic_result',
    reads: [
      'One of the two DNS servers is not answering for the sign-in host.',
      'Asked each name server the same question. The second one did not answer twice.',
      'One of our three resolvers stays silent.',
    ],
    doesNotRead: [
      'Both name servers answered every time.',
      'The customer did not answer my email about the plan.',
    ],
  },
  {
    id: 'F06 network change reported',
    signal: 'sig.recent-network-change-reported',
    role: 'customer_network_admin',
    type: 'customer_email',
    reads: [
      'We introduced a new TLS inspection policy on the gateway last week.',
      'A new web filter rule went on yesterday.',
      'The firewall rule was enabled on Monday.',
    ],
    doesNotRead: [
      'We will switch on a new web filter next week.',
      'No inspection policy was enabled.',
    ],
  },
  {
    id: 'F08 timeout in words',
    signal: 'sig.error-timeout',
    role: 'customer_end_user',
    type: 'customer_email',
    reads: [
      'People see an error that the connection timed out when they sign in.',
      'Teams says the request timed out at login.',
    ],
    doesNotRead: [
      'The print server connection timed out.',
      'The label printer says the connection timed out.',
    ],
  },
  {
    id: 'F11 proxy comparison by the engineer',
    signal: 'sig.proxy-node-inconsistent',
    role: 'support_engineer',
    type: 'diagnostic_result',
    reads: [
      'Tested every proxy node. proxy-07 timed out on all attempts.',
      'One of the three proxy servers times out for the sign-in hosts.',
    ],
    doesNotRead: [
      'Please test whether proxy-07 times out.',
      'All the proxy nodes responded normally.',
    ],
  },
  {
    id: 'F12 access policy changed',
    signal: 'sig.recent-ca-change-reported',
    role: 'customer_admin',
    type: 'customer_email',
    reads: [
      'Our security team enabled a new compliance policy yesterday.',
      'On Monday we updated the session policy.',
      'The conditional access rules were modified two days ago.',
    ],
    doesNotRead: [
      'We will tighten the access policy next week.',
      'The password policy was changed yesterday.',
    ],
  },
  {
    id: 'F19 access policy unchanged',
    signal: 'sig.ca-config-unchanged',
    role: 'customer_admin',
    type: 'customer_email',
    reads: [
      'Nothing was changed in our access policies.',
      'We have not touched the conditional access rules.',
      'No changes were made to the security policy.',
    ],
    doesNotRead: [
      'Something was changed in our access policies.',
      'The printer policy is unchanged.',
    ],
  },
  {
    id: 'F16 only one user',
    signal: 'sig.single-user-scope',
    role: 'customer_end_user',
    type: 'customer_email',
    reads: [
      'It is only my laptop that cannot sign in.',
      'Just me, as far as I know.',
      'My teammates next to me are fine.',
    ],
    doesNotRead: ['It is not just me.', 'It is not just one person.'],
  },
  {
    id: 'F17 no primary refresh token',
    signal: 'sig.prt-missing',
    role: 'support_engineer',
    type: 'diagnostic_result',
    reads: [
      'The device has no primary refresh token.',
      'PRT is missing on this laptop.',
      'dsregcmd shows it does not have a PRT.',
    ],
    doesNotRead: ['The device has a primary refresh token.', 'We will check the PRT tomorrow.'],
  },
  {
    id: 'F09 cache or reinstall did nothing',
    signal: 'sig.cache-clear-no-effect',
    role: 'customer_end_user',
    type: 'customer_email',
    reads: [
      'We cleared the cache and reinstalled. It still fails the same way.',
      'Deleted the Teams cache. No difference at all.',
      'We reinstalled the app but nothing changed.',
    ],
    doesNotRead: [
      'We cleared the cache and it works now.',
      'Please clear the cache and tell us if it still fails.',
    ],
  },
  {
    id: 'F10 signing everyone out did nothing',
    signal: 'sig.revoke-sessions-no-effect',
    role: 'customer_admin',
    type: 'customer_email',
    reads: ['We signed everyone out and back in. Same failures as before.'],
    doesNotRead: ['We signed everyone out of the meeting room.'],
  },
  {
    id: 'F14 excluding a user did nothing',
    signal: 'sig.ca-exclusion-no-effect',
    role: 'customer_admin',
    type: 'customer_email',
    reads: ['We excluded the pilot user. They are still blocked with the same message.'],
    doesNotRead: ['We excluded the pilot user and it works now.'],
  },
  {
    id: 'F21 the browser version fails too',
    signal: 'sig.web-client-also-fails',
    role: 'customer_end_user',
    type: 'customer_email',
    reads: ['The browser version also fails.', 'Teams in the browser shows the same error.'],
    doesNotRead: [
      'Teams in the browser works on the same laptop.',
      'The web client signs in fine on this device.',
    ],
  },
];

describe('wording families', () => {
  for (const family of FAMILIES) {
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

describe('a message written the way people chat', () => {
  it('is read through the shorthand and typos in the list', () => {
    const event = eventOf(
      'customer_end_user',
      'customer_email',
      'about 70 ppl at the site cant login. it somtimes goes thru, sometimes not',
    );
    const found = signalsOf(event);
    expect(found).toContain('sig.multiple-users-affected');
    expect(found).toContain('sig.intermittent-failures');
  });

  it('keeps every excerpt inside the stored text', () => {
    const body = 'pls note: our ppl r fine at the Gdansk office. Sign-ins fail somtimes.';
    const event = eventOf('customer_end_user', 'customer_email', body);
    for (const o of detectObservations(createFullView([event], null), pack, 'case_fam')) {
      expect(o.start).not.toBeNull();
      expect(o.end).not.toBeNull();
      expect(o.end ?? 0).toBeLessThanOrEqual(body.length);
      expect(body.slice(o.start ?? 0, o.end ?? 0).length).toBeGreaterThan(0);
    }
  });
});
