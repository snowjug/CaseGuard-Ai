import { describe, expect, it } from 'vitest';
import type { CaseEvent, EventType, ParticipantRole } from '@caseguard/schemas';
import { createFullView, detectObservations, getCompiledPack } from '../src';

/**
 * The wording families for how many are affected and where, how the failure shows itself, and what the people at the
 * keyboard tried (`WORDING_FAMILIES_SCOPE` in the knowledge pack). For each signal: sentences it must read, written for
 * this test and not taken from the evaluation cases, and look-alikes it must not read. The look-alikes include the ones
 * the first version of a family got wrong when it was measured: a printer's timeout, a request that sounds like a result.
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
    id: `scope_${counter}`,
    caseId: 'case_scope',
    sourceId: 'src_scope',
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
  detectObservations(createFullView([event], null), pack, 'case_scope').map((o) => o.signalId);

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
    id: 'F21 a count that is more than a handful',
    signal: 'sig.multiple-users-affected',
    role: 'customer_admin',
    type: 'customer_email',
    reads: [
      'Around thirty colleagues in the Brno office cannot sign in to Teams.',
      'About nine users on the shared desktops are locked out since this morning.',
      'We have 7 devices that fail to sign in, all of them bought last month.',
      'It affects roughly forty mobile workers, the office staff are fine.',
      'Twelve people so far cannot sign in, and more are calling in.',
      'A lot of our staff are stuck on the sign-in screen.',
      'The whole office cannot get into Teams since the morning.',
      'Dozens of users are blocked as soon as they start the app.',
    ],
    doesNotRead: [
      'Nine users attended the training on Tuesday.',
      'We bought twelve laptops for the new floor last week.',
      'Please add three people to the distribution list.',
      'The whole office is closed on Friday for the move.',
      'Two users cannot sign in.',
      'Twelve users confirm there are no more errors since the change.',
      'No more problems reported by the fifteen people we asked.',
      'The forty people on the ground floor are not affected.',
    ],
  },
  {
    id: 'F22 only the writer is affected',
    signal: 'sig.single-user-scope',
    role: 'customer_end_user',
    type: 'customer_email',
    reads: [
      'My laptop will not sign in. A colleague at the next desk has no problem at all.',
      'Nobody else on our floor has this, I asked around.',
      'My colleagues are fine, it is just my account that loops.',
      'The coworker sitting beside me is fine, only I get the error.',
    ],
    doesNotRead: [
      'Many colleagues report the same error.',
      'No one else has replied to the survey yet.',
      'A colleague is helping me with the screenshot.',
    ],
  },
  {
    id: 'F23 the failures follow a place or a network',
    signal: 'sig.site-correlated',
    role: 'customer_admin',
    type: 'customer_email',
    reads: [
      'Our other site in Gdynia is fine, the problem is only here.',
      'The rest of our offices work normally.',
      'Floor 2 is not affected, the people on floors 3 and 4 are.',
      'Only Tallinn is affected, as far as we can tell.',
      'On mobile data Teams signs in without delay, so it may be the building network.',
      'Teams works on my phone hotspot but not on the office wifi.',
    ],
    doesNotRead: [
      'Only one user is affected, I think.',
      'Only admins are affected by the new policy.',
      'The other site is closed for the holiday.',
      'I charged my phone on mobile data day.',
    ],
  },
  {
    id: 'F24 a retry that works',
    signal: 'sig.intermittent-failures',
    role: 'customer_end_user',
    type: 'customer_email',
    reads: [
      'The first attempt fails and the second try works.',
      'Teams signs in after three attempts, never on the first.',
      'It needs two or three retries before it lets me in.',
      'Sometimes it opens straight away and sometimes it just spins.',
      'It worked for a minute and then failed again.',
    ],
    doesNotRead: [
      'It fails every single time.',
      'The second try is scheduled for Friday.',
      'Please try a second time and tell me what happens.',
    ],
  },
  {
    id: 'F25 a connection timeout on the screen',
    signal: 'sig.error-timeout',
    role: 'customer_end_user',
    type: 'customer_email',
    reads: [
      'Teams sign-in fails for the whole team since lunch. The error is a connection timed out message.',
      'I cannot log in to Teams today and the screen shows connection timed out.',
    ],
    doesNotRead: [
      'The label printer on the second floor says the connection timed out. Teams works fine for all of us.',
      'Our backup job reports connection timed out every night.',
    ],
  },
  {
    id: 'F26 a name that could not be found, in the words of the screen',
    signal: 'sig.error-name-not-resolved',
    role: 'customer_end_user',
    type: 'customer_email',
    reads: [
      'Teams opens, spins, then says it could not find the server.',
      'Teams will not start at all. The app shows that it cannot resolve the host and offers a Retry button.',
    ],
    doesNotRead: [
      'The printer says it could not find the server.',
      'Please tell me which servers the laptops use.',
    ],
  },
  {
    id: 'F27 the browser version does the same',
    signal: 'sig.web-client-also-fails',
    role: 'customer_end_user',
    type: 'customer_email',
    reads: [
      'Teams on the desktop fails, and the web version does the same.',
      'The browser client does the same thing, so it is not the app.',
    ],
    doesNotRead: [
      'The web version of Teams opens fine for me.',
      'I did the same in the browser as yesterday.',
    ],
  },
  {
    id: 'F28 the cache was cleared and nothing changed',
    signal: 'sig.cache-clear-no-effect',
    role: 'customer_admin',
    type: 'customer_email',
    reads: [
      'I emptied the Teams cache folder on that laptop and the prompt is still there.',
      'Cache cleared and Teams reinstalled on four PCs, same result.',
      'We deleted the profile folder, no difference at all.',
    ],
    doesNotRead: [
      'I emptied the cache folder and it works now.',
      'Should I empty the cache folder? Nothing changed since yesterday.',
      'We bought a new cache server, same result as the old one.',
    ],
  },
  {
    id: 'F29 clearing or resetting fixed it',
    signal: 'sig.cache-clear-resolved',
    role: 'support_engineer',
    type: 'resolution_note',
    reads: [
      'Resetting the profile and the cache fixed all nine users.',
      'Cleared the Teams cache on the laptop and it worked.',
    ],
    doesNotRead: [
      'Please close Teams, delete the cache folder and sign in again.',
      'I emptied the cache folder and she signed in again, but the same error appeared.',
      'We reset the password and the audit report works now.',
    ],
  },
  {
    id: 'F30 the sessions were revoked and nothing changed',
    signal: 'sig.revoke-sessions-no-effect',
    role: 'customer_admin',
    type: 'customer_email',
    reads: [
      'I revoked the sessions of those users this morning. Same result, they still fail.',
      'Sessions revoked at ten. The three testers got the same code again.',
    ],
    doesNotRead: [
      'Please revoke the sessions of the three users and tell me what happens.',
      'We revoked the sessions and everyone could sign in.',
    ],
  },
];

describe('wording families for scope, symptoms and what was tried', () => {
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

describe('the families only read what a customer says', () => {
  it('does not read a count of machines in an engineer message', () => {
    const event = eventOf(
      'support_engineer',
      'engineer_email',
      'About nine users are locked out according to the monitoring.',
    );
    expect(signalsOf(event)).not.toContain('sig.multiple-users-affected');
  });
});
