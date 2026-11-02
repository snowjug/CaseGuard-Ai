import { PARAPHRASE_CASES } from './corpus-paraphrase';
import { C, S, type EvalCase } from './types';

const DISCLAIMER =
  'This e-mail and any attachments are confidential and intended solely for the addressee. If you have received it in error, please notify the sender and delete it.';

/**
 * Noisy cases: the facts of a clean story, wrapped in what real mail and chat carry (typos, signatures, disclaimers,
 * quoted history, auto-replies, unrelated look-alike text, a message in another language). The labels name only what
 * the writer says in that event; text quoted from an earlier message is not new evidence.
 */
export const NOISY_CASES: readonly EvalCase[] = [
  {
    id: 'n1-warsaw-noisy',
    group: 'noisy',
    causes: [C.dns],
    about:
      'the Warsaw name server story, with typos, a disclaimer, quoted history and an auto-reply',
    earliestMissed: null,
    events: [
      {
        key: 'ev01',
        at: 0,
        who: 'customer',
        type: 'customer_email',
        title: 'teams login problm warsaw',
        text: `Hi, sice about nine this mornig our Warsaw ofice, roughly 45 peple, keeps geting thrown out of Teams when they sign in. If u wait a minute and try agian it somtimes goes thru, sometimes not. Gdansk colegues r fine.\n\n--\nJan K.\nIT Operations | Example Corp\n${DISCLAIMER}`,
        signals: [S.manyUsers, S.intermittent, S.siteCorrelated],
      },
      {
        key: 'ev02',
        at: 25,
        who: 'engineer',
        type: 'engineer_email',
        title: 'Re: teams login problm warsaw',
        text: 'Thanks for the quick description. I need three example users and the UTC time of a failed sign-in for each, and please say which DNS servers and which proxy the Warsaw computers use.\n\nOn 2 Jun 2026 at 08:00 Jan K. wrote:\n> Hi, sice about nine this mornig our Warsaw ofice, roughly 45 peple, keeps geting thrown out of Teams\n> when they sign in. If u wait a minute and try agian it somtimes goes thru, sometimes not.\n> Gdansk colegues r fine.',
      },
      {
        key: 'ev03',
        at: 50,
        who: 'customer',
        type: 'customer_email',
        title: 'Automatic reply: teams login problm warsaw',
        text: 'I am out of the office until Monday with limited access to e-mail. For urgent matters please contact the service desk on extension 4400.',
      },
      {
        key: 'ev04',
        at: 85,
        who: 'customer',
        type: 'customer_email',
        title: 'Re: teams login problm warsaw',
        text: `Users: a.kowal 08:14:10 UTC, m.nowak 08:16:55 UTC, t.wisniewski 08:20:31 UTC. DNS servers in Warsaw are 10.20.1.10 and 10.20.1.11, no proxy. Teams says the name of the server could not be resolved.\n\n> I need three example users and the UTC time of a failed sign-in for each\n\nJan K.\n${DISCLAIMER}`,
        signals: [S.nameNotResolved],
      },
      {
        key: 'ev05',
        at: 120,
        who: 'engineer',
        type: 'diagnostic_result',
        title: 'sign-in logs',
        text: 'ok so i looked at the entra sign-in logs, those 3 users, around those times. nothing there at all. the requests never made it to entra.',
        signals: [S.noServerRecords],
      },
      {
        key: 'ev06',
        at: 140,
        who: 'engineer',
        type: 'diagnostic_result',
        title: 'name servers',
        text: 'asked both name servers for login.microsoftonline.com 5 times each. .10 answers every time, instantly. .11 stays silent 4 out of 5.',
        signals: [S.resolverBad],
      },
      {
        key: 'ev07',
        at: 150,
        who: 'customer',
        type: 'customer_email',
        title: 'Invitation: weekly vendor sync',
        text: 'You are invited to the weekly vendor sync, Wednesday 10:00 to 10:30, in meeting room Delta or online. Please accept or decline.',
      },
      {
        key: 'ev08',
        at: 215,
        who: 'network',
        type: 'customer_email',
        title: 'Re: teams login problm warsaw',
        text: 'yes - thursday we enabled a new webfilter policy on .11. already took it out of the dhcp scope.',
        signals: [S.networkChange],
      },
      {
        key: 'ev09',
        at: 280,
        who: 'customer',
        type: 'customer_email',
        title: 'Re: teams login problm warsaw',
        text: `15 logins since then, all ok.\n\nJan K.\nIT Operations | Example Corp`,
        signals: [S.dnsFixed],
      },
    ],
  },
  {
    id: 'n2-utrecht-chat',
    group: 'noisy',
    causes: [C.proxy],
    about:
      'the Utrecht proxy story as chat fragments, with a pasted printer log that looks like a Teams error',
    earliestMissed: 'ev02',
    events: [
      {
        key: 'ev01',
        at: 0,
        who: 'customer',
        type: 'customer_email',
        title: 'utrecht teams',
        text: 'utrecht. about 70 ppl. teams says connection timed out at login. comes and goes. other sites ok as far as i know',
        signals: [S.manyUsers, S.timeoutError, S.intermittent, S.siteCorrelated],
      },
      {
        key: 'ev02',
        at: 30,
        who: 'engineer',
        type: 'engineer_email',
        title: 'Re: utrecht teams',
        text: 'pls clear the teams cache and reinstall on one pc and tell me what happens',
      },
      {
        key: 'ev03',
        at: 150,
        who: 'customer',
        type: 'customer_email',
        title: 'Re: utrecht teams',
        text: 'did both on 5 pcs. nothing changed. teams in the browser fails the same way.\n\nunrelated, our print server logged this today:\nspooler: job 1432 timed out waiting for device HP-2F-03\nspooler: name HP-2F-03.corp could not be resolved\nspooler: job 1432 cancelled',
        signals: [S.cacheNoEffect, S.webAlsoFails],
      },
      {
        key: 'ev04',
        at: 175,
        who: 'engineer',
        type: 'engineer_email',
        title: 'Re: utrecht teams',
        text: 'ok. pls sign the pilot group out of all sessions and back in',
      },
      {
        key: 'ev05',
        at: 260,
        who: 'customer',
        type: 'customer_email',
        title: 'Re: utrecht teams',
        text: 'did it. same failures.',
        signals: [S.revokeNoEffect],
      },
      {
        key: 'ev06',
        at: 290,
        who: 'engineer',
        type: 'diagnostic_result',
        title: 'sign-in logs',
        text: 'checked the entra sign-in logs of the pilot users. no failure rows for the times they failed',
        signals: [S.noServerRecords],
      },
      {
        key: 'ev07',
        at: 330,
        who: 'engineer',
        type: 'diagnostic_result',
        title: 'proxies',
        text: 'tried login.microsoftonline.com through all 4 proxies. 3 are fine. proxy-04 times out every time',
        signals: [S.proxyBad],
      },
      {
        key: 'ev08',
        at: 400,
        who: 'network',
        type: 'customer_email',
        title: 'Re: proxies',
        text: 'new cert inspection profile went on that cluster last tue. proxy-04 is out of the lb now',
        signals: [S.networkChange],
      },
      {
        key: 'ev09',
        at: 460,
        who: 'customer',
        type: 'customer_email',
        title: 'Re: proxies',
        text: 'no more timeouts. 20 logins ok',
        signals: [S.proxyFixed],
      },
      {
        key: 'ev10',
        at: 480,
        who: 'customer',
        type: 'customer_email',
        title: 'Re: proxies',
        text: 'thanks, have a good weekend!',
      },
    ],
  },
  {
    id: 'n3-lisbon-mixed-language',
    group: 'noisy',
    causes: [C.conditionalAccess],
    about: 'the access-rule story with one message written mostly in Portuguese',
    earliestMissed: null,
    events: [
      {
        key: 'ev01',
        at: 0,
        who: 'customer',
        type: 'customer_email',
        title: 'Teams bloqueado',
        text: 'Olá. Desde segunda-feira muitos utilizadores estão bloqueados no Teams, in all offices, more than 100 people. It says access is blocked by the organisation, or it asks for the second factor again and again.',
        signals: [S.manyUsers],
      },
      {
        key: 'ev02',
        at: 30,
        who: 'engineer',
        type: 'engineer_email',
        title: 'Re: Teams bloqueado',
        text: 'Thank you. Could you list three affected users and one UTC time at which each of them was refused? Please also tell me whether any access settings changed shortly before Monday.',
      },
      {
        key: 'ev03',
        at: 95,
        who: 'customer',
        type: 'customer_email',
        title: 'Re: Teams bloqueado',
        text: 'Sim, na sexta-feira a equipa de segurança ativou uma nova regra de acesso que só permite dispositivos geridos e conformes. Utilizadores: r.silva 08:02 UTC, c.santos 08:07 UTC, p.costa 08:11 UTC.',
        signals: [S.caChange],
      },
      {
        key: 'ev04',
        at: 130,
        who: 'engineer',
        type: 'diagnostic_result',
        title: 'Sign-in log check',
        text: 'The failed attempts of all three users are in the Entra sign-in logs, each one stopped by Conditional Access because of the device-compliance rule.',
        signals: [S.serverRecords, S.mfaCaEvents],
      },
      {
        key: 'ev05',
        at: 150,
        who: 'engineer',
        type: 'diagnostic_result',
        title: 'Service health check',
        text: 'Service health has no active incident for sign-in or Teams.',
        signals: [S.healthClear],
      },
      {
        key: 'ev06',
        at: 260,
        who: 'customer',
        type: 'customer_email',
        title: 'Re: Teams bloqueado',
        text: 'We left the test user out of that rule and waited, still blocked, same message.',
        signals: [S.caExclusionNoEffect],
      },
    ],
  },
];

const NOISY_BY_ID = new Map(NOISY_CASES.map((candidate) => [candidate.id, candidate]));

const base = (id: string): EvalCase => {
  const found = PARAPHRASE_CASES.find((candidate) => candidate.id === id) ?? NOISY_BY_ID.get(id);
  if (!found) throw new Error(`unknown base case ${id}`);
  return found;
};

/**
 * Negative controls: cases in which a naive detector would see something and a reader would not. Nothing here is a
 * Teams sign-in failure unless a label says so, and no decision point is expected in any of them.
 */
export const NEGATIVE_CASES: readonly EvalCase[] = [
  {
    id: 'z1-scheduling',
    group: 'negative',
    about: 'two people arrange a call about the roll-out',
    earliestMissed: null,
    events: [
      {
        key: 'ev01',
        at: 0,
        who: 'customer',
        type: 'customer_email',
        title: 'Call tomorrow',
        text: "Hi, could we move tomorrow's call about the Teams roll-out to 15:00? The training team has a clash in the morning.",
      },
      {
        key: 'ev02',
        at: 20,
        who: 'engineer',
        type: 'engineer_email',
        title: 'Re: Call tomorrow',
        text: 'Sure, 15:00 works for me. I will send a new invitation now.',
      },
      {
        key: 'ev03',
        at: 45,
        who: 'customer',
        type: 'customer_email',
        title: 'Re: Call tomorrow',
        text: 'Thanks. Could you also send the agenda beforehand?',
      },
      {
        key: 'ev04',
        at: 60,
        who: 'engineer',
        type: 'engineer_email',
        title: 'Re: Call tomorrow',
        text: 'The agenda is attached: roll-out plan, training dates and the list of support contacts.',
      },
    ],
  },
  {
    id: 'z2-licence-question',
    group: 'negative',
    about: 'a licensing question with no failure in it',
    earliestMissed: null,
    events: [
      {
        key: 'ev01',
        at: 0,
        who: 'customer',
        type: 'customer_email',
        title: 'Licences for phone calls',
        text: 'Which licence do our sales staff need to make and receive phone calls in Teams, and can we limit which external guests are allowed to join our meetings?',
      },
      {
        key: 'ev02',
        at: 35,
        who: 'engineer',
        type: 'engineer_email',
        title: 'Re: Licences for phone calls',
        text: 'Phone calls need a Teams Phone licence plus either a calling plan or direct routing. Guests can be limited in the Teams admin centre under external access, either to named domains or to none.',
      },
      {
        key: 'ev03',
        at: 80,
        who: 'customer',
        type: 'customer_email',
        title: 'Re: Licences for phone calls',
        text: 'That answers it, thank you. We will assign the licences next week.',
      },
    ],
  },
  {
    id: 'z3-printer-lookalike',
    group: 'negative',
    about:
      'a printer problem whose error text looks like a Teams error, and no Teams failure at all',
    earliestMissed: null,
    events: [
      {
        key: 'ev01',
        at: 0,
        who: 'customer',
        type: 'customer_email',
        title: 'Label printer on floor 2',
        text: 'The label printer on the second floor says the connection timed out and that the name of the print server could not be resolved. It is only my desk that has the problem. Teams works fine for all of us.',
      },
      {
        key: 'ev02',
        at: 30,
        who: 'engineer',
        type: 'engineer_email',
        title: 'Re: Label printer on floor 2',
        text: 'That sounds like a printer or print server matter, not Teams. Please contact your print administrator and check the printer settings.',
      },
    ],
  },
  {
    id: 'z4-negations',
    group: 'negative',
    about:
      'a single user says what is not the case: not intermittent, not a whole team, nothing changed',
    earliestMissed: null,
    events: [
      {
        key: 'ev01',
        at: 0,
        who: 'enduser',
        type: 'customer_email',
        title: 'Teams will not let me in',
        text: 'To be clear, this is not intermittent: it fails every single time I try. It is only me, not a whole team, and nothing was changed in our access policies.',
        signals: [S.singleUser, S.caUnchanged],
      },
      {
        key: 'ev02',
        at: 25,
        who: 'engineer',
        type: 'engineer_email',
        title: 'Re: Teams will not let me in',
        text: 'Thank you. Please tell me your user name and when exactly, in UTC, one of the failed attempts happened.',
      },
      {
        key: 'ev03',
        at: 70,
        who: 'enduser',
        type: 'customer_email',
        title: 'Re: Teams will not let me in',
        text: 'It was 08:41 UTC and my user name is k.larsen. Same as always, it fails each time.',
      },
    ],
  },
];

/**
 * Reordered cases: the same events as a clean or a noisy case, handed over in another order. A reader sorts by time;
 * so must the engine, so the analysis of a reordered case has to equal that of its source exactly.
 */
export const REORDERED_CASES: readonly EvalCase[] = [
  {
    ...base('p1-warsaw-resolver'),
    id: 'r1-warsaw-shuffled',
    group: 'reordered',
    basedOn: 'p1-warsaw-resolver',
    order: ['ev05', 'ev01', 'ev08', 'ev03', 'ev09', 'ev02', 'ev07', 'ev04', 'ev06'],
  },
  {
    ...base('p2-utrecht-proxy'),
    id: 'r2-utrecht-reversed',
    group: 'reordered',
    basedOn: 'p2-utrecht-proxy',
    order: ['ev10', 'ev09', 'ev08', 'ev07', 'ev06', 'ev05', 'ev04', 'ev03', 'ev02', 'ev01'],
  },
  {
    ...base('n1-warsaw-noisy'),
    id: 'r3-warsaw-noisy-swapped',
    group: 'reordered',
    basedOn: 'n1-warsaw-noisy',
    order: ['ev02', 'ev01', 'ev04', 'ev03', 'ev06', 'ev05', 'ev08', 'ev07', 'ev09'],
  },
];
