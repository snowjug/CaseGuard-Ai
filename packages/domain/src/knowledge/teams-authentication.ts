import type {
  KnowledgeAction,
  KnowledgeHypothesis,
  KnowledgePack,
  KnowledgeRequirement,
  KnowledgeSignal,
  SignalDetector,
} from '@caseguard/schemas';

/**
 * Teams authentication knowledge pack (illustrative, authored for the CaseGuard demo).
 *
 * Every probability, time and effort figure below is an ESTIMATE made by the CaseGuard authors to
 * make the reasoning inspectable. It is not Microsoft guidance, not measured data, and must be
 * replaced with curated, validated content before any real use (assumption A-06).
 */

export const H = {
  dns: 'hyp.dns-resolution',
  proxy: 'hyp.proxy-egress',
  ca: 'hyp.conditional-access',
  token: 'hyp.token-session',
  client: 'hyp.client-cache',
  fed: 'hyp.federation',
  service: 'hyp.service-incident',
  device: 'hyp.device-state',
  other: 'hyp.other',
} as const;

/** Likelihood vector in the fixed hypothesis order: dns, proxy, ca, token, client, fed, service, device, other. */
function L(
  dns: number,
  proxy: number,
  ca: number,
  token: number,
  client: number,
  fed: number,
  service: number,
  device: number,
  other: number,
): Record<string, number> {
  return {
    [H.dns]: dns,
    [H.proxy]: proxy,
    [H.ca]: ca,
    [H.token]: token,
    [H.client]: client,
    [H.fed]: fed,
    [H.service]: service,
    [H.device]: device,
    [H.other]: other,
  };
}

const CUSTOMER_ROLES = ['customer_admin', 'customer_end_user', 'customer_network_admin'] as const;
const rx = (
  pattern: string,
  extra: Partial<Extract<SignalDetector, { kind: 'regex' }>> = {},
): SignalDetector => ({
  kind: 'regex',
  pattern,
  flags: 'i',
  ...extra,
});
const st = (
  key: string,
  op: Extract<SignalDetector, { kind: 'structured' }>['op'],
  value?: string | number | boolean,
): SignalDetector =>
  value === undefined ? { kind: 'structured', key, op } : { kind: 'structured', key, op, value };
/** All structured conditions must hold on the same event. */
const stAll = (
  ...conditions: {
    key: string;
    op: Extract<SignalDetector, { kind: 'structured' }>['op'];
    value?: string | number | boolean;
  }[]
): SignalDetector => ({ kind: 'structured_all', conditions });

/**
 * Reusable pieces of the wording families below (wave 2). Each is a bounded fragment: every gap has an upper limit, nothing
 * nests a repetition, and a fragment never matches across more than one sentence unless a pattern says so on purpose.
 */
/** A gap inside one sentence: no full stop, except one between two digits (an address such as 10.20.1.11). */
const GAP = String.raw`(?:[^.\n]|(?<=\d)\.(?=\d))`;
/** Something said about sign-in and the people who sign in: the context that makes an error message about Teams. */
const SIGNIN_CONTEXT = String.raw`(?:teams|sign(?:ing|s)?[- ]?in|log(?:ging|s)?[- ]?in|logon|users?|people|staff|colleagues|employees)`;
/** When something changed, as a customer says it: a time relative to now, or a named day. */
const WHEN_RELATIVE = String.raw`(?:yesterday|today|tonight|this (?:morning|afternoon|week)|last (?:night|week)|(?:\d{1,2}|a|an|two|three|few|several) (?:hours?|days?|weeks?) ago|recently)`;
const WHEN_WEEKDAY = String.raw`(?:(?:last|on) (?:mon|tues|wednes|thurs|fri|satur|sun)day(?: (?:morning|afternoon|evening))?)`;
/** What was done to a policy or a setting. */
const CHANGED = String.raw`(?:(?:chang|updat|modif|enabl|deploy|introduc|activat|appl|shorten|tighten)\w{0,5}|rolled out|(?:turn|switch)(?:ed)? on|went on|put in place)`;
/** An access rule, in the words people use for it. */
const ACCESS_RULE = String.raw`(?:conditional access|ca polic\w{0,6}|(?:access|security|compliance|mfa|session|device|sign-?in) (?:rule|polic\w{0,6}|setting|control)s?)`;
/** The engineer's roles, for a signal an engineer's own test can show. */
const ENG_ROLES = ['support_engineer', 'escalation_engineer'] as const;
/** Events in which an engineer reports what a log or a query showed (a pasted message can open with any verb). */
const LOG_RESULT_TYPES: NonNullable<Extract<SignalDetector, { kind: 'regex' }>['eventTypes']> = [
  'query_output',
  'diagnostic_result',
  'escalation_response',
  'case_note',
  'engineer_action',
  'engineer_email',
];

const hypotheses: KnowledgeHypothesis[] = [
  {
    id: H.dns,
    name: 'DNS resolution failure for sign-in endpoints',
    description:
      'One or more DNS resolvers used by the affected network intermittently fail to resolve Microsoft sign-in or CDN hosts, so the sign-in page never finishes loading before authentication starts.',
    category: 'network',
    prior: 0.1,
    assumptions: [
      'Affected clients alternate between at least two resolvers (round robin or primary/secondary)',
      'The failure occurs before the request reaches Microsoft Entra ID, so no server-side sign-in record exists',
    ],
    keywords: ['dns', 'resolver', 'name resolution', 'nxdomain', 'servfail', 'domain name'],
    validatingActionIds: ['act.dns-resolver-comparison'],
    confirmationRequirementIds: ['req.network-path-check'],
  },
  {
    id: H.proxy,
    name: 'Egress proxy or TLS-inspection node failure',
    description:
      'A web proxy or TLS-inspection node in a proxy pool times out or drops connections to sign-in endpoints, so some attempts fail depending on which node serves the request.',
    category: 'network',
    prior: 0.1,
    assumptions: [
      'Clients reach Microsoft endpoints through a proxy pool with more than one node',
      'The failing node is overloaded, misconfigured, or inspecting traffic it should bypass',
    ],
    keywords: [
      'proxy',
      'tls inspection',
      'ssl inspection',
      'pac file',
      'web gateway',
      'proxy node',
    ],
    validatingActionIds: ['act.proxy-node-comparison'],
    confirmationRequirementIds: ['req.network-path-check'],
  },
  {
    id: H.ca,
    name: 'Conditional Access or MFA policy enforcement',
    description:
      'A Conditional Access or MFA policy change forces interactive sign-in or blocks attempts, producing server-side sign-in failures that align in time with the reported failures.',
    category: 'identity',
    prior: 0.2,
    assumptions: [
      'The policy changed or started applying shortly before the failures began',
      'Failing attempts appear in Microsoft Entra sign-in logs with a Conditional Access result',
    ],
    keywords: ['conditional access', 'ca policy', 'mfa', 'multi-factor', 'aadsts50076'],
    validatingActionIds: ['act.signin-log-correlation', 'act.review-ca-policy-config'],
    confirmationRequirementIds: ['req.server-side-correlation'],
  },
  {
    id: H.token,
    name: 'Token or session lifetime problem',
    description:
      'Refresh tokens or sessions expire, are revoked, or hit sign-in frequency limits, forcing repeated authentication that sometimes fails.',
    category: 'identity',
    prior: 0.11,
    assumptions: ['Failing attempts appear in sign-in logs with token or session error codes'],
    keywords: [
      'token lifetime',
      'session lifetime',
      'refresh token',
      'sign-in frequency',
      'token expir',
      'expired token',
    ],
    validatingActionIds: ['act.signin-log-correlation'],
    confirmationRequirementIds: ['req.server-side-correlation'],
  },
  {
    id: H.client,
    name: 'Corrupted Teams client cache or WAM broker state',
    description:
      'Local Teams cache or Web Account Manager state on affected devices is corrupted, so sign-in fails on those devices regardless of network or policy.',
    category: 'client',
    prior: 0.15,
    assumptions: ['The problem follows the device rather than the network or the user'],
    keywords: ['teams cache', 'clear cache', 'cache', 'reinstall', 'wam', 'broker', 'corrupt'],
    validatingActionIds: ['act.clear-teams-cache'],
    confirmationRequirementIds: ['req.client-diagnostics'],
  },
  {
    id: H.fed,
    name: 'Federation or identity-provider node issue',
    description:
      'A federation server (STS) node has an expired certificate, clock skew, or a fault, causing sign-in failures for the share of users routed to it.',
    category: 'identity',
    prior: 0.09,
    assumptions: ['The customer uses a federated identity provider with multiple nodes'],
    keywords: ['federation', 'adfs', 'ad fs', 'sts', 'idp'],
    validatingActionIds: ['act.check-federation-health'],
    confirmationRequirementIds: ['req.client-diagnostics'],
  },
  {
    id: H.service,
    name: 'Microsoft-side service incident',
    description:
      'A service incident or regional degradation affects sign-in for many tenants at once.',
    category: 'service',
    prior: 0.07,
    assumptions: ['The incident would be visible in Service health or the Message center'],
    keywords: ['service health', 'incident', 'outage', 'degradation', 'microsoft side'],
    validatingActionIds: ['act.check-service-health'],
    confirmationRequirementIds: [],
  },
  {
    id: H.device,
    name: 'Device registration or primary refresh token health',
    description:
      'Affected devices have unhealthy registration or no primary refresh token, so silent sign-in fails and the user is prompted or blocked.',
    category: 'client',
    prior: 0.08,
    assumptions: ['Failures are confined to specific devices with join/registration problems'],
    keywords: ['prt', 'primary refresh token', 'device registration', 'hybrid join', 'dsregcmd'],
    validatingActionIds: ['act.device-registration-check'],
    confirmationRequirementIds: ['req.client-diagnostics'],
  },
  {
    id: H.other,
    name: 'Other or not yet characterised',
    description:
      'Probability mass the pack cannot attribute to a named hypothesis. It shrinks as evidence accumulates.',
    category: 'unknown',
    prior: 0.1,
    assumptions: [],
    keywords: [],
    validatingActionIds: [],
    confirmationRequirementIds: [],
  },
];

const signals: KnowledgeSignal[] = [
  {
    id: 'sig.intermittent-failures',
    label: 'Failures are intermittent',
    description: 'A retry sometimes succeeds; the failure is not deterministic.',
    detectors: [
      rx(
        String.raw`\b(intermittent(ly)?|sometimes (works|fails|succeeds)|on and off|off and on|randomly|comes? and goes?|hit and miss|flaky|retry (usually |sometimes )?(works|succeeds)|retr(y|ies)[^.\n]{0,30}sometimes)\b`,
        { roles: [...CUSTOMER_ROLES] },
      ),
      // "sometimes it goes through", "now and then a second attempt works": a frequency word and an outcome.
      rx(
        String.raw`\b(?:sometimes|occasionally|now and then|every now and then|from time to time|once in a while|at times|every so often)\b${GAP}{0,40}\b(?:works?|fails?|succeeds?|(?:goes?|gets?) through|connects?|sign(?:s|ed)? in|logs? in|(?:does ?n['’]?t|does not|do not|don['’]t) (?:work|go through|connect|help))\b`,
        { roles: [...CUSTOMER_ROLES] },
      ),
      // "not constant", "not every time": the failure is there some of the time.
      rx(String.raw`\bnot (?:constant|permanent|consistent|continuous|every time|always)\b`, {
        roles: [...CUSTOMER_ROLES],
      }),
    ],
    strength: 'moderate',
    evidenceKind: 'presence',
    category: 'customer_reported',
    likelihoods: L(0.85, 0.85, 0.3, 0.5, 0.4, 0.7, 0.6, 0.4, 0.5),
    neutral: 0.5,
    explanation:
      'Deterministic policy decisions rarely produce intermittent failures, whereas node-by-node infrastructure problems usually do.',
    satisfies: [],
    twinSection: 'scope',
  },
  {
    id: 'sig.multiple-users-affected',
    label: 'Multiple users affected at once',
    description: 'More than a handful of users report the same problem in the same period.',
    detectors: [
      rx(
        String.raw`\b(\d{2,4}|dozens of|many|multiple|several|all)(?<!\b(?:revok|reset|forc|disabl|delet|remov|wip|migrat|assign|enrol|add)[^.\n]{0,34})\s+(of our\s+)?(users|people|agents|employees|staff|colleagues|supervisors)\b(?![ a-z]{0,14}?(?:(?:repl|respond|test|verif|check)(?:ed|ied)|confirmed(?!\s+(?:the|that|they|it|this)\b))\b)(?![^.\n]{0,30}\b(?:are|were) (?:in|on|part of|members? of) (?:it\b|(?:the|that|this|our|a) [\w ]{0,15}?(?:group|list|policy|scope|pilot|set)\b))`,
        { roles: [...CUSTOMER_ROLES] },
      ),
    ],
    strength: 'moderate',
    evidenceKind: 'presence',
    category: 'customer_reported',
    likelihoods: L(0.8, 0.85, 0.7, 0.45, 0.15, 0.85, 0.85, 0.2, 0.5),
    neutral: 0.5,
    explanation:
      'Per-device causes (cache, device state) rarely hit dozens of users simultaneously; shared infrastructure does.',
    satisfies: ['req.affected-scope'],
    twinSection: 'scope',
  },
  {
    id: 'sig.site-correlated',
    label: 'Failures concentrate at specific sites or networks',
    description: 'Some sites or networks are affected much more than others.',
    detectors: [
      rx(
        String.raw`\b(only|mostly|mainly|primarily|much worse|worse|more (often|frequent(ly)?))\b(?!\s+(?:one|1|a single|a|an|two|three)\s+(?:user|person|people|device|laptop|pc|machine|account|colleague|employee|member)\b)[^.\n]{0,70}\b(office|site|branch|network|subnet|vlan|location)\b`,
        { roles: [...CUSTOMER_ROLES] },
      ),
      rx(
        String.raw`\bother (sites|offices|locations|branches|networks)\b[^.\n]{0,50}\b(are|is)?\s*(fine|working|unaffected|not (affected|impacted)|ok)\b`,
        { roles: [...CUSTOMER_ROLES] },
      ),
      // "colleagues at our Gdansk office have no trouble", "the Gdansk team is fine": a named place that is not affected.
      rx(
        String.raw`\b(?:colleagues|users|people|staff|everyone|everybody|employees|team|office)\b${GAP}{0,30}\b(?:at|in|from)\b${GAP}{0,30}\b(?:office|site|branch|location|campus|building)\b${GAP}{0,40}\b(?:have|has) no (?:trouble|problems?|issues?)\b`,
        { roles: [...CUSTOMER_ROLES] },
      ),
      rx(
        String.raw`(?!(?:the|our|my|your|their|this|that|these|those|all|some|any|every|each|other|most|no)\b)\b[A-Za-z]{3,20} (?:colleagues|users|people|staff|team|office|site) (?:are|is) (?:fine|ok|okay|unaffected|working(?: fine| normally)?)\b`,
        { roles: [...CUSTOMER_ROLES] },
      ),
    ],
    strength: 'strong',
    evidenceKind: 'presence',
    category: 'customer_reported',
    likelihoods: L(0.85, 0.85, 0.25, 0.15, 0.15, 0.35, 0.15, 0.15, 0.4),
    neutral: 0.4,
    explanation:
      'Identity-side causes follow the user or tenant, not the physical network, so concentration at specific sites points to the network path.',
    satisfies: ['req.site-pattern'],
    twinSection: 'scope',
  },
  {
    id: 'sig.single-user-scope',
    label: 'Only one user or device is affected',
    description: 'The report is confined to a single user or a single device.',
    detectors: [
      rx(String.raw`\b(only|just) (one|1|a single) (user|person|device|pc|laptop)\b`, {
        roles: [...CUSTOMER_ROLES],
      }),
    ],
    strength: 'strong',
    evidenceKind: 'presence',
    category: 'customer_reported',
    likelihoods: L(0.08, 0.08, 0.35, 0.45, 0.85, 0.1, 0.05, 0.7, 0.4),
    neutral: 0.3,
    explanation:
      'A single-user scope favours per-device or per-account causes over shared infrastructure.',
    satisfies: ['req.affected-scope'],
  },
  {
    id: 'sig.error-name-not-resolved',
    label: 'Client reports a name-resolution failure',
    description:
      'The Teams client error tag caa82ee7 (a WinINET "name not resolved" style code) or an ERR_NAME_NOT_RESOLVED / NXDOMAIN message appears.',
    detectors: [
      // The codes and the browser's own message say it by themselves.
      rx(String.raw`\b(caa82ee7|0x80072ee7|ERR_NAME_NOT_RESOLVED|DNS_PROBE_FINISHED_NXDOMAIN)\b`),
      // The same thing in words ("the name of the server could not be resolved"), read only in a sentence about Teams or
      // about signing in: a printer's or a print server's error does not count.
      rx(
        String.raw`\b${SIGNIN_CONTEXT}\b${GAP}{0,80}\bname\b${GAP}{0,30}\b(?:could ?n['’]?t|could not|cannot|can['’]?t|was not|is not|not|unable to|failed to)\s+(?:be\s+)?resolved?\b`,
      ),
      rx(
        String.raw`\bname\b${GAP}{0,30}\b(?:could ?n['’]?t|could not|cannot|can['’]?t|was not|is not|not|unable to|failed to)\s+(?:be\s+)?resolved?\b${GAP}{0,60}\b${SIGNIN_CONTEXT}\b`,
      ),
      rx(
        String.raw`\b${SIGNIN_CONTEXT}\b${GAP}{0,80}\b(?:can['’]?t|cannot|could ?n['’]?t) resolve (?:the )?host`,
      ),
    ],
    strength: 'strong',
    evidenceKind: 'presence',
    category: 'diagnostic_evidence',
    likelihoods: L(0.9, 0.2, 0.02, 0.03, 0.08, 0.05, 0.05, 0.03, 0.25),
    neutral: 0.1,
    explanation:
      'A name-resolution error is raised before any request reaches the identity provider, which points at DNS rather than policy or tokens.',
    satisfies: ['req.error-code'],
  },
  {
    id: 'sig.error-timeout',
    label: 'Client reports a connection timeout',
    description: 'The Teams client error tag caa82ee2 or an ERR_TIMED_OUT style message appears.',
    detectors: [
      rx(
        String.raw`\b(caa82ee2|0x80072ee2|ERR_(CONNECTION_)?TIMED_OUT|ETIMEDOUT|request timed out)\b`,
      ),
      // "the connection timed out", said about Teams or about signing in (a printer's error does not count).
      rx(
        String.raw`\b${SIGNIN_CONTEXT}\b${GAP}{0,80}\b(?:connection|request|sign-?in|login|page|server)\b${GAP}{0,15}\btim(?:ed|es|e)? ?out\b`,
      ),
      rx(
        String.raw`\b(?:connection|request|sign-?in|login|page|server)\b${GAP}{0,15}\btim(?:ed|es|e)? ?out\b${GAP}{0,60}\b${SIGNIN_CONTEXT}\b`,
      ),
    ],
    strength: 'strong',
    evidenceKind: 'presence',
    category: 'diagnostic_evidence',
    likelihoods: L(0.25, 0.85, 0.03, 0.05, 0.1, 0.25, 0.4, 0.05, 0.3),
    neutral: 0.1,
    explanation:
      'Timeouts are typical of an overloaded or filtering network hop (proxy, firewall) and are rarely produced by policy decisions.',
    satisfies: ['req.error-code'],
  },
  {
    id: 'sig.mfa-ca-events-in-logs',
    label: 'MFA / Conditional Access events exist in sign-in logs',
    description:
      'Sign-in log rows with AADSTS50076, 50074 or Conditional Access failure results are present.',
    detectors: [
      rx(String.raw`\bAADSTS(50076|50074|53003|53000|530003)\b|ConditionalAccessStatus\W+failure`, {
        eventTypes: ['query_output', 'log_sample', 'diagnostic_result'],
      }),
      // "each one is marked as stopped by Conditional Access", "an interrupted multi-factor step".
      rx(
        String.raw`\b(?:stopped|blocked|failed|interrupted|denied|marked|rejected)\b${GAP}{0,40}\b(?:by|due to|because of)\b${GAP}{0,20}\bconditional access\b`,
        { eventTypes: LOG_RESULT_TYPES },
      ),
      rx(
        String.raw`\b(?:interrupted|failed|incomplete|abandoned)\b${GAP}{0,20}\b(?:mfa|multi-?factor)\b`,
        { eventTypes: LOG_RESULT_TYPES },
      ),
    ],
    strength: 'moderate',
    evidenceKind: 'presence',
    category: 'diagnostic_evidence',
    likelihoods: L(0.3, 0.3, 0.8, 0.35, 0.3, 0.3, 0.3, 0.35, 0.3),
    neutral: 0.3,
    explanation:
      'MFA prompts are ordinary background noise in most tenants, so their mere existence is weak evidence unless they line up in time with the failures.',
    satisfies: [],
  },
  {
    id: 'sig.token-expiry-errors',
    label: 'Token expiry or session revocation errors in logs',
    description: 'Sign-in logs show AADSTS70043, 700082, 50173, 50132 or 50133.',
    detectors: [
      rx(String.raw`\bAADSTS(70043|700082|50173|50132|50133)\b`, {
        eventTypes: ['query_output', 'log_sample', 'diagnostic_result'],
      }),
      // "errors 70043 and 700082", "the token has expired": the code without its prefix, or the meaning in words.
      rx(String.raw`\b(?:errors?|codes?)\s+(?:70043|700082|50173|50132|50133)\b`, {
        eventTypes: LOG_RESULT_TYPES,
      }),
      rx(String.raw`\btoken (?:has |had |is )?(?:expired|no longer valid)\b`, {
        eventTypes: LOG_RESULT_TYPES,
      }),
    ],
    strength: 'moderate',
    evidenceKind: 'presence',
    category: 'diagnostic_evidence',
    likelihoods: L(0.08, 0.08, 0.3, 0.8, 0.15, 0.1, 0.1, 0.25, 0.2),
    neutral: 0.15,
    explanation: 'These codes are specific to expired, revoked or frequency-limited sessions.',
    satisfies: [],
  },
  {
    id: 'sig.policy-events-outside-failure-window',
    label: 'Policy-related log events do not coincide with the failures',
    description:
      'Query output was annotated as having zero rows inside the reported failure window, so the policy-related events it found are unrelated background.',
    detectors: [
      st('rowsInFailureWindow', 'eq', 0),
      rx(
        String.raw`\bnone of (these|the) (rows|events|entries)\b[^.\n]{0,40}\b(fall|are|occur)\b[^.\n]{0,30}\b(within|in)\b[^.\n]{0,30}\bfailure window\b`,
      ),
    ],
    strength: 'strong',
    evidenceKind: 'absence',
    category: 'diagnostic_evidence',
    likelihoods: L(0.7, 0.7, 0.1, 0.15, 0.65, 0.55, 0.55, 0.6, 0.55),
    neutral: 0.6,
    explanation:
      'If a policy were causing the failures its log events would fall inside the failure window; events outside it contradict that explanation.',
    satisfies: [],
  },
  {
    id: 'sig.no-server-side-failure-records',
    label: 'No server-side sign-in records for the failing attempts',
    description:
      'Correlating failing attempts (user + UTC time) with Entra sign-in logs finds no matching failure records: the requests never reached the identity service.',
    detectors: [
      st('correlationMatchedFailures', 'eq', 0),
      rx(
        String.raw`\b(0|zero|no)\s{1,3}(of\s{1,3}\d{1,5}\s{1,3})?(failing attempts\s{1,3})?(have\s{1,3})?(a\s{1,3})?(matching\s{1,3})?(failed\s{1,3})?(sign-?in\s{1,3})?(records?|entries|rows|events)\b[^.\n]{0,60}\b(failing|failure|failed|attempts?)\b(?!\s+(?:window|period|time ?frame|range|interval)\b)`,
        { eventTypes: LOG_RESULT_TYPES },
      ),
      // "no failure rows for the times they failed". A bare "nothing" is read only when the log is named before it (below).
      rx(
        String.raw`\b(?:no [\w ]{0,25}\b(?:records?|entries|rows|events|traces?)|not a single (?:record|entry|row|event|failure))\b${GAP}{0,60}\b(?:for|of|from|in|at|matching|around|during)\b${GAP}{0,50}\b(?:attempts?|failures?|users?|times?|minutes?|sign-?ins?|logs?)\b`,
        { eventTypes: LOG_RESULT_TYPES },
      ),
      // "no failures are recorded for any of them".
      rx(
        String.raw`\bno [\w ]{0,25}\bfailures?\b${GAP}{0,20}\b(?:recorded|logged|found|present|listed|shown|visible)\b`,
        { eventTypes: LOG_RESULT_TYPES },
      ),
      // "looked at the sign-in logs ... nothing there at all": the log is named in the sentence before.
      rx(
        String.raw`\b(?:sign-?in logs?|audit logs?|entra|azure ad|the logs?)\b${GAP}{0,100}\.${GAP}{0,25}\b(?:nothing\b(?!\s+(?:(?:is|was|has been|have been)\s+)?(?:known|confirmed|certain|decided|clear|settled|final|proven|determined|established|sure|obvious)\b)|no [\w ]{0,25}\b(?:records?|entries|rows|events|failures?))\b`,
        { eventTypes: LOG_RESULT_TYPES },
      ),
      // "the requests never got as far as Entra".
      rx(
        String.raw`\bnever (?:got|made it|reached|arrived)\b${GAP}{0,30}\b(?:entra|azure ad|the identity (?:provider|service)|microsoft)\b`,
        { eventTypes: LOG_RESULT_TYPES },
      ),
    ],
    strength: 'strong',
    evidenceKind: 'absence',
    category: 'diagnostic_evidence',
    likelihoods: L(0.92, 0.92, 0.04, 0.06, 0.55, 0.45, 0.25, 0.45, 0.4),
    neutral: 0.4,
    explanation:
      'If failing attempts leave no trace in the identity service logs, the failure happened before authentication - on the client or the network path.',
    satisfies: ['req.server-side-correlation'],
  },
  {
    id: 'sig.server-side-failure-records-present',
    label: 'Failing attempts have matching server-side failure records',
    description: 'Correlation finds failed sign-in records at the reported times.',
    detectors: [
      st('correlationMatchedFailures', 'gt', 0),
      rx(String.raw`\b\d+ of \d+ failing attempts (have|had) (a )?matching (failed )?sign-?in`, {
        eventTypes: LOG_RESULT_TYPES,
      }),
      // "all three failed attempts are in the Entra sign-in logs".
      rx(
        String.raw`\b(?:failed|failing|failures?|sign-?in failures?|attempts?)\b${GAP}{0,60}\b(?:are|were|appears?|shown?|recorded|logged|present|visible|found)\b${GAP}{0,40}\b(?:in|on)\b${GAP}{0,20}\b(?:sign-?in logs?|audit logs?|entra|azure ad|logs?)\b`,
        { eventTypes: LOG_RESULT_TYPES },
      ),
      // "the logs show errors 70043 and 700082": a denial inside the sentence ("the logs do not show any failures") turns it round.
      rx(
        String.raw`\b(?:logs?|sign-?in logs?)\b${GAP}{0,20}\b(?:show(?:s|ed)?|list(?:s|ed)?|contain(?:s|ed)?)\b${GAP}{0,40}\b(?:errors?|failures?|failed)\b`,
        { eventTypes: LOG_RESULT_TYPES },
      ),
    ],
    strength: 'strong',
    evidenceKind: 'presence',
    category: 'diagnostic_evidence',
    likelihoods: L(0.04, 0.04, 0.65, 0.65, 0.1, 0.35, 0.55, 0.35, 0.4),
    neutral: 0.4,
    explanation: 'Server-side failure records place the problem at or after the identity service.',
    satisfies: ['req.server-side-correlation'],
  },
  {
    id: 'sig.cache-clear-no-effect',
    label: 'Clearing the client cache or reinstalling did not help',
    description: 'Cache clearing, a clean profile, or a reinstall left the failures unchanged.',
    detectors: [
      rx(
        String.raw`(clean|new|fresh) (teams )?profile[^.\n]{0,60}(still|also) fail|(cleared|deleted|reset)[^.\n]{0,40}cache[^.\n]{0,100}(still|continues?|persists?|didn'?t help|no change)|reinstall(ed)?[^.\n]{0,60}(still|same)`,
        { roles: [...CUSTOMER_ROLES] },
      ),
    ],
    strength: 'strong',
    evidenceKind: 'presence',
    category: 'customer_reported',
    likelihoods: L(0.7, 0.7, 0.7, 0.55, 0.05, 0.7, 0.7, 0.3, 0.55),
    neutral: 0.6,
    explanation:
      'A cache-corruption explanation predicts that clearing the cache fixes the device; persistence contradicts it.',
    satisfies: [],
  },
  {
    id: 'sig.cache-clear-resolved',
    label: 'Clearing the client cache fixed the device',
    description: 'The device signs in successfully after clearing cache or reinstalling.',
    detectors: [
      rx(
        String.raw`(cleared|deleted|reset)[^.\n]{0,40}cache[^.\n]{0,100}(fixed|resolved|works now|now works|signed in)`,
        { roles: [...CUSTOMER_ROLES] },
      ),
    ],
    strength: 'strong',
    evidenceKind: 'presence',
    category: 'customer_reported',
    likelihoods: L(0.1, 0.1, 0.1, 0.15, 0.85, 0.1, 0.1, 0.3, 0.2),
    neutral: 0.15,
    explanation: 'Resolution by clearing local state is characteristic of client-side corruption.',
    satisfies: [],
  },
  {
    id: 'sig.web-client-also-fails',
    label: 'The browser version of Teams also fails',
    description: 'Teams on the web fails too, so the desktop client is not the sole factor.',
    detectors: [
      // The browser version fails the same way: a failure word is needed, "the same laptop" is not one.
      rx(
        String.raw`(browser|web client|teams\.microsoft\.com|teams web|web teams)[^.\n]{0,80}(also (?:fails?|failing|errors?|times? out|does ?n['’]?t work|does not work|breaks?)|same (?:error|failure|problem|issue|message|timeout)|fail(?:s|ed|ing)? (?:too|in exactly the same way|the same way)|(?:fails?|errors?) the same)`,
        { roles: [...CUSTOMER_ROLES] },
      ),
    ],
    strength: 'moderate',
    evidenceKind: 'presence',
    category: 'customer_reported',
    likelihoods: L(0.7, 0.75, 0.75, 0.55, 0.1, 0.75, 0.8, 0.35, 0.5),
    neutral: 0.5,
    explanation: 'A web-client failure makes a desktop-only cache or broker problem unlikely.',
    satisfies: [],
  },
  {
    id: 'sig.prt-healthy',
    label: 'Primary refresh token is healthy on sampled devices',
    description: 'dsregcmd output shows AzureAdPrt: YES.',
    detectors: [rx(String.raw`AzureAdPrt\s*:\s*YES|PrimaryRefreshToken\W+(present|yes)`)],
    strength: 'moderate',
    evidenceKind: 'presence',
    category: 'diagnostic_evidence',
    likelihoods: L(0.8, 0.8, 0.8, 0.6, 0.5, 0.8, 0.8, 0.03, 0.7),
    neutral: 0.7,
    explanation: 'A healthy PRT contradicts a device-registration explanation.',
    satisfies: ['req.client-diagnostics'],
  },
  {
    id: 'sig.prt-missing',
    label: 'Primary refresh token is missing on sampled devices',
    description: 'dsregcmd output shows AzureAdPrt: NO.',
    detectors: [rx(String.raw`AzureAdPrt\s*:\s*NO`)],
    strength: 'moderate',
    evidenceKind: 'presence',
    category: 'diagnostic_evidence',
    likelihoods: L(0.05, 0.05, 0.3, 0.5, 0.3, 0.1, 0.05, 0.85, 0.2),
    neutral: 0.15,
    explanation: 'A missing PRT is characteristic of device registration or token problems.',
    satisfies: ['req.client-diagnostics'],
  },
  {
    id: 'sig.recent-ca-change-reported',
    label: 'Customer reports a recent Conditional Access change',
    description: 'A Conditional Access or MFA policy was changed shortly before onset.',
    detectors: [
      rx(
        String.raw`(conditional access|ca policy|mfa policy)[^.\n]{0,80}(was |were |has been |have been )?(changed|updated|modified|enabled|deployed)[^.\n]{0,60}(yesterday|today|this (morning|week)|last night|hours? ago)`,
        { roles: [...CUSTOMER_ROLES] },
      ),
    ],
    strength: 'moderate',
    evidenceKind: 'presence',
    category: 'customer_reported',
    likelihoods: L(0.2, 0.2, 0.8, 0.35, 0.2, 0.2, 0.2, 0.2, 0.2),
    neutral: 0.2,
    explanation: 'A policy change close to onset raises the policy hypothesis.',
    satisfies: ['req.change-history'],
  },
  {
    id: 'sig.ca-config-unchanged',
    label: 'Conditional Access configuration has not changed recently',
    description: 'The customer or a config review shows no recent policy change.',
    detectors: [
      rx(
        String.raw`(conditional access|ca policy|sign-in frequency)[^.\n]{0,80}(unchanged|no changes?|not changed|last (edit(ed)?|modified|changed))`,
      ),
      rx(
        String.raw`last (conditional access )?polic(y|ies) (edit|change|modification)[^.\n]{0,40}(weeks?|months?) ago`,
      ),
    ],
    strength: 'moderate',
    evidenceKind: 'absence',
    category: 'customer_reported',
    likelihoods: L(0.75, 0.75, 0.12, 0.35, 0.75, 0.75, 0.75, 0.75, 0.7),
    neutral: 0.75,
    explanation: 'An unchanged policy set makes a sudden policy-driven failure less plausible.',
    satisfies: ['req.change-history'],
  },
  {
    id: 'sig.recent-network-change-reported',
    label: 'A DNS, proxy or filtering change was deployed shortly before onset',
    description:
      'A network-side policy change (DNS filtering, proxy/TLS inspection, firewall) preceded the failures.',
    detectors: [
      rx(
        String.raw`(dns|resolver|proxy|proxies|firewall|web filter|secure web gateway|network)[^.\n]{0,80}(policy|rule|filter|blocklist|category|inspection)[^.\n]{0,80}(updated|changed|deployed|rolled out|pushed|enabled|set to)`,
        { roles: [...CUSTOMER_ROLES] },
      ),
      rx(
        String.raw`(deployed|rolled out|pushed|enabled|changed|updated)[^.\n]{0,60}(inspection|filter|filtering|blocklist|policy)[^.\n]{0,80}(proxy|proxies|dns|resolver|firewall|gateway)`,
        { roles: [...CUSTOMER_ROLES] },
      ),
    ],
    strength: 'moderate',
    evidenceKind: 'presence',
    category: 'customer_reported',
    likelihoods: L(0.85, 0.8, 0.1, 0.08, 0.1, 0.15, 0.1, 0.08, 0.3),
    neutral: 0.15,
    explanation: 'A network-side change close to onset raises the network hypotheses.',
    satisfies: ['req.change-history'],
  },
  {
    id: 'sig.service-health-clear',
    label: 'No active Microsoft service incident',
    description: 'Service health and the Message center show no relevant incident.',
    detectors: [
      rx(
        String.raw`(service health|message center)[^.\n]{0,80}(no|not)[^.\n]{0,40}(incident|advisory|issue)|no (active )?(incidents|advisories) (reported|posted|found)`,
      ),
    ],
    strength: 'moderate',
    evidenceKind: 'absence',
    category: 'diagnostic_evidence',
    likelihoods: L(0.85, 0.85, 0.85, 0.85, 0.85, 0.85, 0.05, 0.85, 0.7),
    neutral: 0.85,
    explanation: 'No incident makes a Microsoft-side outage unlikely.',
    satisfies: [],
  },
  {
    id: 'sig.service-health-incident',
    label: 'An active Microsoft service incident matches the symptoms',
    description: 'Service health lists an active incident affecting sign-in or Teams.',
    detectors: [
      rx(
        String.raw`(service health|incident|advisory)[^.\n]{0,60}(active|ongoing|degradation|investigating)\b`,
        {
          eventTypes: ['case_note', 'diagnostic_result', 'engineer_email', 'escalation_response'],
        },
      ),
    ],
    strength: 'strong',
    evidenceKind: 'presence',
    category: 'diagnostic_evidence',
    likelihoods: L(0.08, 0.08, 0.08, 0.1, 0.05, 0.1, 0.95, 0.05, 0.2),
    neutral: 0.08,
    explanation:
      'A matching active incident is the strongest explanation for a sudden, widespread failure.',
    satisfies: [],
  },
  {
    id: 'sig.federation-node-error',
    label: 'Federation server errors, certificate or clock problems',
    description: 'AD FS or STS logs show certificate, clock-skew or node errors.',
    detectors: [
      rx(
        String.raw`(ad ?fs|federation|\bsts\b)[^.\n]{0,80}(certificate|clock|time skew|event id|error|failed)`,
        {
          eventTypes: ['diagnostic_result', 'log_sample', 'customer_email', 'case_note'],
        },
      ),
    ],
    strength: 'moderate',
    evidenceKind: 'presence',
    category: 'diagnostic_evidence',
    likelihoods: L(0.1, 0.1, 0.1, 0.1, 0.1, 0.85, 0.1, 0.1, 0.2),
    neutral: 0.1,
    explanation:
      'Errors on a federation node explain failures for the share of users routed to it.',
    satisfies: [],
  },
  {
    id: 'sig.resolver-inconsistent',
    label: 'One DNS resolver fails or blocks sign-in hosts while others answer',
    description:
      'A per-resolver name-resolution test shows at least one resolver failing for sign-in or CDN hosts.',
    detectors: [
      st('resolversFailing', 'gt', 0),
      rx(
        String.raw`\b(one of|1 of)\s+(the\s+)?(\d+|two|three)\s+(dns\s+)?(resolvers|servers)\b[^.\n]{0,80}(fail|refus|block|servfail|nxdomain)`,
      ),
    ],
    strength: 'strong',
    evidenceKind: 'presence',
    category: 'diagnostic_evidence',
    likelihoods: L(0.97, 0.05, 0.02, 0.02, 0.03, 0.03, 0.03, 0.02, 0.1),
    neutral: 0.03,
    explanation:
      'Clients that alternate between resolvers fail intermittently when one resolver is broken.',
    satisfies: ['req.network-path-check'],
  },
  {
    id: 'sig.resolvers-consistent',
    label: 'All DNS resolvers answer sign-in hosts consistently',
    description: 'A per-resolver test shows every resolver answering normally.',
    detectors: [st('resolversFailing', 'eq', 0)],
    strength: 'strong',
    evidenceKind: 'absence',
    category: 'diagnostic_evidence',
    likelihoods: L(0.06, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.8),
    neutral: 0.9,
    explanation: 'If every resolver is healthy, DNS is unlikely to be the cause.',
    satisfies: ['req.network-path-check'],
  },
  {
    id: 'sig.proxy-node-inconsistent',
    label: 'One proxy node times out while others respond',
    description:
      'A per-node test shows at least one proxy node timing out or failing for sign-in hosts.',
    detectors: [
      st('proxyNodesFailing', 'gt', 0),
      rx(
        String.raw`\bproxy[- ]?[\w-]{0,40}\d?\b[^.\n]{0,60}\b(times? out|timeouts?|fails?|dropped)\b[^.\n]{0,60}\b(one in \w+|roughly|about|some|intermittent)`,
        { roles: ['customer_network_admin'] },
      ),
      // "proxy-04 timed out every single time", "one of the four proxy servers times out": a test result, by whoever ran it.
      rx(
        String.raw`\bproxy[- ]?[\w-]{0,20}\d\b${GAP}{0,40}\b(?:times? out|timed out|timeouts?|fails?|failed|dropped|not responding|unresponsive)\b`,
        { roles: [...ENG_ROLES, 'customer_network_admin'] },
      ),
      rx(
        String.raw`\b(?:one|1) of (?:the |our |your )?(?:two|three|four|five|\d{1,2}) proxy (?:servers|nodes)\b${GAP}{0,80}\b(?:times? out|timed out|fails?|failed|not responding|dropped)\b`,
        { roles: [...ENG_ROLES, 'customer_network_admin'] },
      ),
    ],
    strength: 'strong',
    evidenceKind: 'presence',
    category: 'diagnostic_evidence',
    likelihoods: L(0.04, 0.97, 0.02, 0.02, 0.03, 0.03, 0.05, 0.02, 0.1),
    neutral: 0.03,
    explanation:
      'Clients whose requests land on the failing node time out; the rest succeed, producing intermittent failures.',
    satisfies: ['req.network-path-check'],
  },
  {
    id: 'sig.proxy-nodes-consistent',
    label: 'All proxy nodes respond consistently',
    description: 'A per-node test shows every proxy node responding normally.',
    detectors: [st('proxyNodesFailing', 'eq', 0)],
    strength: 'strong',
    evidenceKind: 'absence',
    category: 'diagnostic_evidence',
    likelihoods: L(0.9, 0.06, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.8),
    neutral: 0.9,
    explanation: 'If every proxy node is healthy, the proxy pool is unlikely to be the cause.',
    satisfies: ['req.network-path-check'],
  },
  {
    id: 'sig.revoke-sessions-no-effect',
    label: 'Revoking user sessions did not change the failure rate',
    description:
      'After sessions were revoked and users signed in again, failures continued unchanged.',
    detectors: [
      rx(
        String.raw`(revok(e|ed|ing)[^.\n]{0,60}(session|token)s?[^.\n]{0,100}(failures? continue|still fail|no change|same)|sessions? (were|was) revoked[^.\n]{0,100}(failures? continue|still fail|no change|same))`,
        { roles: [...CUSTOMER_ROLES] },
      ),
    ],
    strength: 'moderate',
    evidenceKind: 'presence',
    category: 'customer_reported',
    likelihoods: L(0.75, 0.75, 0.25, 0.08, 0.7, 0.7, 0.75, 0.6, 0.6),
    neutral: 0.7,
    explanation:
      'A token or session explanation predicts that forcing re-authentication changes behaviour.',
    satisfies: [],
  },
  {
    id: 'sig.ca-exclusion-no-effect',
    label: 'Excluding users from the MFA policy did not help',
    description:
      'After users were excluded from the MFA / Conditional Access policy, failures continued.',
    detectors: [
      rx(
        String.raw`(exclud(e|ed|ing)|bypass(ed)?)[^.\n]{0,70}(from|for)[^.\n]{0,70}(mfa|ca |conditional access|polic)[^.\n]{0,120}(failures? continue|still fail|no change|same|continues?)`,
        { roles: [...CUSTOMER_ROLES] },
      ),
    ],
    strength: 'strong',
    evidenceKind: 'presence',
    category: 'customer_reported',
    likelihoods: L(0.8, 0.8, 0.03, 0.2, 0.8, 0.75, 0.8, 0.7, 0.6),
    neutral: 0.75,
    explanation:
      'If the policy were the cause, excluding affected users would have changed the outcome.',
    satisfies: [],
  },
  {
    id: 'sig.dns-fix-resolved',
    label: 'Failures stopped after the DNS resolver fix',
    description:
      'After the failing resolver was removed or the DNS policy corrected, failures stopped.',
    detectors: [
      stAll(
        { key: 'fixTarget', op: 'eq', value: 'dns-resolver' },
        { key: 'failuresAfterChange', op: 'eq', value: 0 },
      ),
    ],
    strength: 'strong',
    evidenceKind: 'presence',
    category: 'diagnostic_evidence',
    likelihoods: L(0.95, 0.05, 0.03, 0.03, 0.04, 0.04, 0.04, 0.03, 0.1),
    neutral: 0.03,
    explanation:
      'A fix that targets one cause and stops the failures strongly supports that cause.',
    satisfies: ['req.fix-validation'],
  },
  {
    id: 'sig.proxy-fix-resolved',
    label: 'Failures stopped after the proxy fix',
    description:
      'After the failing proxy node was removed from rotation or inspection was bypassed, failures stopped.',
    detectors: [
      stAll(
        { key: 'fixTarget', op: 'eq', value: 'proxy-node' },
        { key: 'failuresAfterChange', op: 'eq', value: 0 },
      ),
    ],
    strength: 'strong',
    evidenceKind: 'presence',
    category: 'diagnostic_evidence',
    likelihoods: L(0.05, 0.95, 0.03, 0.03, 0.04, 0.04, 0.04, 0.03, 0.1),
    neutral: 0.03,
    explanation:
      'A fix that targets one cause and stops the failures strongly supports that cause.',
    satisfies: ['req.fix-validation'],
  },
];

/**
 * Wording families added in wave 2 (see docs/MISS_TAXONOMY.md). Each entry names the family it belongs to and is added to the
 * signal's own detectors, so the original patterns stay as they were and what was added can be read in one place. A family is
 * a way of saying a thing, not a list of the sentences that failed: each one has positive and look-alike examples in
 * `test/detector-families.test.ts`.
 */
const WORDING_FAMILIES: Readonly<Record<string, readonly SignalDetector[]>> = {
  // F05: one of several name servers does not answer, said in words.
  'sig.resolver-inconsistent': [
    rx(
      String.raw`\b(?:one|1) of (?:your |the |our )?(?:two|three|four|\d{1,2})? ?(?:dns |name )?(?:servers|resolvers|name servers)\b${GAP}{0,80}\b(?:not answering|does ?n['’]?t answer|did not answer|stays? silent|silent|times? out|timed out|fail(?:s|ed|ing)?|unresponsive|not responding|refus(?:es|ed))`,
    ),
    rx(
      String.raw`\b(?:name servers?|dns servers?|resolvers?)\b[^\n]{0,200}?\b(?:(?:did ?n['’]?t|did not|does not|doesn['’]t|never|fails? to)\s+(?:answer|respond|reply)|stays? silent|(?:is|was|stayed) silent|(?:is|was|are) not (?:answering|responding|replying))\b`,
    ),
  ],
  // F06: a network change, said with the verbs and nouns people use (the network admin's own report).
  'sig.recent-network-change-reported': [
    rx(
      String.raw`\b(?:switched on|turned on|rolled out|put in place|introduced|enabled|deployed|activated|applied|pushed|went on|set up)\b${GAP}{0,60}\b(?:web ?filter\w{0,10}|filtering|filter polic\w{0,6}|(?:cert(?:ificate)?|tls|ssl) inspection|inspection (?:profile|polic\w{0,6})|proxy polic\w{0,6}|dns polic\w{0,6}|blocklist|firewall rule)\b`,
      { roles: [...CUSTOMER_ROLES] },
    ),
    rx(
      String.raw`\b(?:web ?filter\w{0,10}|filtering|(?:cert(?:ificate)?|tls|ssl) inspection|inspection (?:profile|polic\w{0,6})|proxy polic\w{0,6}|dns polic\w{0,6}|blocklist|firewall rule)\b${GAP}{0,30}\b(?:went on|was (?:switched|turned) on|was (?:rolled out|enabled|deployed|activated|applied|pushed|introduced)|got (?:rolled out|enabled|deployed|pushed))\b`,
      { roles: [...CUSTOMER_ROLES] },
    ),
  ],
  // F12: an access policy was changed, with the time said in the many ways people say it (relative, or a named day).
  'sig.recent-ca-change-reported': [WHEN_RELATIVE, WHEN_WEEKDAY].flatMap((when) =>
    [
      String.raw`\b${when}\b[^.\n]{0,80}\b${CHANGED}\b[^.\n]{0,60}\b${ACCESS_RULE}\b`,
      String.raw`\b${CHANGED}\b[^.\n]{0,60}\b${ACCESS_RULE}\b[^.\n]{0,80}\b${when}\b`,
      String.raw`\b${ACCESS_RULE}\b[^.\n]{0,80}\b${CHANGED}\b[^.\n]{0,60}\b${when}\b`,
    ].map((pattern) => rx(pattern, { roles: [...CUSTOMER_ROLES] })),
  ),
  // F19: nothing was changed in the access policy, said with a negative quantifier.
  'sig.ca-config-unchanged': [
    rx(
      String.raw`\b(?:nothing|no [\w ]{0,25}\bchanges?|not been (?:changed|modified|touched|updated)|(?:have|has|had) ?(?:not|n['’]?t) (?:changed|touched|modified|updated)|(?:did|do) ?(?:not|n['’]?t) (?:change|touch|modify|update))\b${GAP}{0,60}\b${ACCESS_RULE}\b`,
    ),
  ],
  // F16: only one user or device is affected, said as "only me" or by the people next to the writer being fine.
  'sig.single-user-scope': [
    rx(
      String.raw`\b(?:only|just)\s+(?:me|myself|my (?:laptop|pc|device|machine|computer|account)|this (?:one )?(?:device|laptop|pc|machine|computer|user|account))\b`,
      { roles: [...CUSTOMER_ROLES] },
    ),
    rx(
      String.raw`\b(?:teammates|team ?mates|coworkers|co-workers|colleagues)\b${GAP}{0,30}\b(?:next to me|beside me|near me|around me|on my team|in my team)\b${GAP}{0,40}\b(?:are|is)\s+(?:fine|ok|okay|normal|unaffected|not affected)\b`,
      { roles: [...CUSTOMER_ROLES] },
    ),
  ],
  // F17: the device has no primary refresh token, said in words and not as dsregcmd output.
  'sig.prt-missing': [
    rx(
      String.raw`\b(?:no|missing|without|lacks?|lacking|does ?n['’]?t have|does not have|has no|not present)\b${GAP}{0,30}\b(?:primary refresh token|prt)\b`,
    ),
    rx(
      String.raw`\b(?:primary refresh token|prt)\b${GAP}{0,30}\b(?:is |was )?(?:missing|absent|not (?:present|issued|found))\b`,
    ),
  ],
  // F09: clearing the cache or reinstalling did nothing, the outcome in the sentence after the action.
  'sig.cache-clear-no-effect': [
    rx(
      String.raw`\b(?:cleared|deleted|removed|reset|wiped)\b[^\n]{0,40}\bcache\b[^\n]{0,140}\b(?:still|continues?|persists?|didn['’]?t help|no (?:change|difference)|nothing changed|same (?:error|failure|problem|message))\b`,
      { roles: [...CUSTOMER_ROLES] },
    ),
    rx(
      String.raw`\breinstall(?:ed)?\b[^\n]{0,100}\b(?:still|no (?:change|difference)|nothing changed|same|didn['’]?t help)\b`,
      { roles: [...CUSTOMER_ROLES] },
    ),
  ],
  // F10: signing everyone out changed nothing, said without the word "revoke".
  'sig.revoke-sessions-no-effect': [
    rx(
      String.raw`\b(?:signed|sign|logged|log)\s+(?:everyone|everybody|all users|all of them|the (?:pilot )?group|users?)\b[^\n]{0,60}\b(?:out|off)\b[^\n]{0,120}\b(?:same|still|no change|no difference|nothing changed)\b`,
      { roles: [...CUSTOMER_ROLES] },
    ),
  ],
  // F14: leaving a user out of the rule changed nothing ("still blocked, same message").
  'sig.ca-exclusion-no-effect': [
    rx(
      String.raw`\b(?:excluded|left out|exempted)\b[^\n]{0,60}\b(?:user|account|them)\b[^\n]{0,120}\b(?:still blocked|still fails?|still cannot|same (?:message|error|block))\b`,
      { roles: [...CUSTOMER_ROLES] },
    ),
    rx(
      String.raw`\b(?:left|took|removed)\b[^\n]{0,40}\b(?:user|account)\b[^\n]{0,20}\bout of\b[^\n]{0,40}\b(?:rule|polic\w{0,6})\b[^\n]{0,80}\b(?:still blocked|still fails?|same (?:message|error))\b`,
      { roles: [...CUSTOMER_ROLES] },
    ),
  ],
};

// Fragments for the families below: a count that is more than a handful, the people or machines it counts, and the
// words that say they have a problem. A detector pattern is at most 500 characters once these are filled in.
const DIGITS_MANY = String.raw`(?:[6-9]|\d{2,5})`;
const WORDS_MANY = String.raw`(?:six|seven|eight|nine|ten|eleven|twelve|(?:thir|four|fif|six|seven|eigh|nine)teen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|dozens?)`;
const PEOPLE = String.raw`(?:(?:mobile|field|remote|office|shift|frontline)\s+)?(?:users|people|persons|employees|staff|colleagues|workers|agents|laptops|devices|pcs|machines|accounts|seats|tablets|phones)`;
const TROUBLE = String.raw`(?:cannot|can['’]?t|can not|unable to|(?:fails?|failing) to|locked out|stuck|blocked|not able to|(?<!\bnot\s)affect\w*)`;
const OTHER_PLACE = String.raw`(?:site|office|location|branch|building|campus|floor|network)`;
const IS_FINE = String.raw`(?:(?:(?:is|are)\s+)?(?:fine|ok|okay|working|unaffected|normal|not (?:affected|impacted))|works?\b|(?:has|have) no (?:problem|trouble|issue)s?|no problem)`;
// A sentence: its characters, with a dot allowed inside a token ("k.saar", "10.1.2.3") but not at a sentence boundary.
const SENT = String.raw`(?:[^.?!\n]|(?<=\w)\.(?=\w))`;
// Said in a paragraph that is about Teams or signing in: the words before the message, so that the message is matched on its
// own and a "cannot" earlier in the sentence does not reach it. A printer's message has no such words before it.
const ABOUT_TEAMS = String.raw`(?<=\b(?:teams|sign(?:ing)?[- ]?in|log(?:ging)?[- ]?in)\b[^\n]{0,200})`;

/**
 * Wording families for how many are affected and where, how the failure shows itself, and what the people at the keyboard
 * tried. Said the way a customer says it: a count in words, a place that is fine, a second try that works, a cache that
 * was cleared to no effect. Kept apart from the maps beside it so that two authors can add families at the same time.
 */
const WORDING_FAMILIES_SCOPE: Readonly<Record<string, readonly SignalDetector[]>> = {
  // F21: more than a handful of people or machines, with a count in digits or in words, whatever they are called, and a
  // failure that is stated: cannot, unable, locked out, stuck, blocked, affected. The count and the failure are said in the
  // same sentence, in either order. Words such as "problem", "error" or "reported" are not enough: "no more errors for
  // twelve users" is a fix, not a failure.
  'sig.multiple-users-affected': [
    rx(
      String.raw`\b${DIGITS_MANY}\s+(?:of\s+(?:our|the|my)\s+)?(?:(?:more|other)\s+)?${PEOPLE}\b${GAP}{0,100}\b${TROUBLE}\b`,
      { roles: [...CUSTOMER_ROLES] },
    ),
    rx(String.raw`\b${WORDS_MANY}\s+${PEOPLE}\b${GAP}{0,80}\b${TROUBLE}\b`, {
      roles: [...CUSTOMER_ROLES],
    }),
    rx(String.raw`\b${TROUBLE}\b${GAP}{0,60}\b${DIGITS_MANY}\s+(?:(?:more|other)\s+)?${PEOPLE}\b`, {
      roles: [...CUSTOMER_ROLES],
    }),
    rx(String.raw`\b${TROUBLE}\b${GAP}{0,60}\b${WORDS_MANY}\s+${PEOPLE}\b`, {
      roles: [...CUSTOMER_ROLES],
    }),
    rx(
      String.raw`\b(?:lots of|a lot of|a number of|numerous|plenty of|loads of)\s+(?:our\s+|the\s+)?${PEOPLE}\b${GAP}{0,60}\b${TROUBLE}\b`,
      { roles: [...CUSTOMER_ROLES] },
    ),
    rx(
      String.raw`\b(?:the )?whole\s+(?:office|site|floor|building|branch|team|department|company|campus|plant|warehouse)\b${GAP}{0,60}\b${TROUBLE}\b`,
      { roles: [...CUSTOMER_ROLES] },
    ),
  ],
  // F22: only the writer is affected, said by the people next to them being fine, or by nobody else having it.
  'sig.single-user-scope': [
    rx(
      String.raw`\b(?:a|one|my|the)\s+(?:colleague|coworker|co-worker|teammate|team ?mate|neighbou?r|desk ?mate)s?\b${GAP}{0,40}\b(?:has|have|is|are|does|do)\s+(?:no (?:problem|trouble|issue)s?|fine|ok|okay|normal|unaffected|not affected|not have (?:this|the|any) (?:problem|issue))`,
      { roles: [...CUSTOMER_ROLES] },
    ),
    rx(
      String.raw`\b(?:nobody|no one|no-one) else\b${GAP}{0,50}\b(?:has|have|gets?|sees?|reports?)\s+(?:this|it|the same|the problem|that)\b`,
      { roles: [...CUSTOMER_ROLES] },
    ),
    rx(
      String.raw`\bmy (?:colleagues|coworkers|co-workers|teammates|team ?mates)\s+(?:are|is|seem)\s+(?:fine|ok|okay|normal|unaffected|not affected)\b`,
      { roles: [...CUSTOMER_ROLES] },
    ),
  ],
  // F23: the failures follow a place or a network: another site is fine, one floor is not affected, mobile data works.
  'sig.site-correlated': [
    rx(String.raw`\b(?:the|our|my|another|one) other ${OTHER_PLACE}\b${GAP}{0,40}\b${IS_FINE}\b`, {
      roles: [...CUSTOMER_ROLES],
    }),
    rx(
      String.raw`\bthe rest of (?:the|our) (?:sites|offices|locations|branches|floors|company|group)\b${GAP}{0,40}\b${IS_FINE}\b`,
      { roles: [...CUSTOMER_ROLES] },
    ),
    rx(
      String.raw`\b(?:floors?|buildings?|sites?|offices?|wings?)\s+[\p{L}\p{N}]{1,12}\s+(?:is|are)\s+(?:not|un)\s?(?:affected|impacted)\b`,
      { roles: [...CUSTOMER_ROLES], flags: 'iu' },
    ),
    rx(
      String.raw`\bonly\s+(?!(?:one|1|a|an|me|my|this|that|the|few|some|two|three|admins?|users?|people|staff|members|those|laptops|devices|accounts)\b)[\p{L}]{3,25}(?:\s+[\p{L}]{3,25})?\s+(?:is|are)\s+(?:affected|impacted)\b`,
      { roles: [...CUSTOMER_ROLES], flags: 'iu' },
    ),
    rx(
      String.raw`\b(?:mobile data|(?:my|his|her|their) (?:phone|hotspot)|a different network|another network|home (?:wi-?fi|network|broadband)|4g|5g|lte|tethering)\b${GAP}{0,60}\b(?:works?|worked|signs? in|signed in|fine|ok|okay|fast|no problem)\b`,
      { roles: [...CUSTOMER_ROLES] },
    ),
    rx(
      String.raw`\b(?:works?|worked|signs? in|signed in)\b${GAP}{0,30}\b(?:on|over|with|using|via)\s+(?:mobile data|(?:my|his|her|their) (?:phone|hotspot)|a different network|another network|home (?:wi-?fi|network|broadband)|4g|5g|lte|tethering)\b`,
      { roles: [...CUSTOMER_ROLES] },
    ),
    // Named places that are fine ("Cork and Galway have no problem"): capitalised words, never a product or a day.
    rx(
      String.raw`\b(?!(?:Teams|Microsoft|Outlook|Windows|Office|Entra|Azure|Chrome|Edge|Firefox|Android|Apple|Zoom|Slack|Word|Excel|PowerPoint|OneDrive|SharePoint|VPN|Wi-?Fi|LAN|DNS|(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day|The|This|That|These|Those|They|She|Everything|Everyone|Everybody|Nothing|Nobody)\b)[A-Z][\p{L}]{2,24}(?:\s+(?:and|or|&)\s+[A-Z][\p{L}]{2,24}){0,2}\s+(?:is|are|work|works|seem|seems)\s+(?:fine|ok|okay|normal|unaffected|not affected|working)\b`,
      { roles: [...CUSTOMER_ROLES], flags: 'u' },
    ),
    rx(
      String.raw`\b(?!(?:Teams|Microsoft|Outlook|Windows|Office|Entra|Azure|Chrome|Edge|Firefox|Android|Apple|Zoom|Slack|Word|Excel|PowerPoint|OneDrive|SharePoint|The|This|That|It|We|They|There|Everything|Everyone|Everybody|Nothing|Nobody)\b)[A-Z][\p{L}]{2,24}(?:\s+(?:and|or|&)\s+[A-Z][\p{L}]{2,24}){0,2}\s+(?:has|have) no (?:problem|trouble|issue)s?\b`,
      { roles: [...CUSTOMER_ROLES], flags: 'u' },
    ),
    // "only the Graz office is hit", "just the warehouse fails": a place named as the only one with the failure.
    rx(
      String.raw`\b(?:only|just|mainly|mostly)\s+(?!(?:one|1|a single|a|an|two|three)\s+(?:user|person|people|device|laptop|pc|machine|account|colleague|employee|member)\b)(?:the\s+|our\s+)?[\p{L} ]{0,30}?(?:site|office|branch|building|campus|floor|location|plant|depot|warehouse|store|region|subnet|vlan)s?\b${GAP}{0,60}\b(?:affect\w*|fail\w*|impact\w*|problems?|cannot|can['’]?t|unable)\b`,
      { roles: [...CUSTOMER_ROLES], flags: 'iu' },
    ),
    // From home, over the VPN or outside the office it works: the failure follows the network.
    rx(
      String.raw`\b(?:from home|over (?:the )?vpn|on (?:the )?vpn|outside (?:the|our) office|(?:the )?guest wi-?fi)\b${GAP}{0,50}\b(?:works?|worked|signs? in|signed in|is fine|is ok|is okay|no problem|fast)\b`,
      { roles: [...CUSTOMER_ROLES] },
    ),
  ],
  // F24: a retry that works, said by the attempt that did: "the second try", "after three attempts", "sometimes... sometimes".
  'sig.intermittent-failures': [
    rx(
      String.raw`\b(?:second|third|next|2nd|3rd) (?:try|attempt|time)\b${GAP}{0,30}\b(?:works?|worked|succeeds?|ok|okay|goes? through)\b`,
      { roles: [...CUSTOMER_ROLES] },
    ),
    rx(
      String.raw`\b(?:works?|worked|succeeds?|goes? through|gets? in|got in|signs? in|signed in|logs? in|logged in|opens?|connects?)\b${GAP}{0,30}\b(?:on|at|after) (?:the )?(?:second|third|2nd|3rd|(?:two|three|four|2|3|4|a few|several) (?:attempts|tries|retries))\b`,
      { roles: [...CUSTOMER_ROLES] },
    ),
    rx(
      String.raw`\b(?:needs?|need|takes?|took|required?)\s+(?:two|three|2|3|a few|several)(?: or (?:two|three|four|2|3|4))? (?:attempts|tries|retries)\b`,
      { roles: [...CUSTOMER_ROLES] },
    ),
    rx(String.raw`\bsometimes\b${GAP}{0,50}[,;]?\s*(?:and |but )?sometimes\b`, {
      roles: [...CUSTOMER_ROLES],
    }),
    rx(
      String.raw`\bworked\b${GAP}{0,30}\bfor (?:a|one) (?:minute|moment|while|few minutes)\b${GAP}{0,30}\b(?:then|and then)\b${GAP}{0,20}\b(?:failed|stopped|broke|fails)\b`,
      { roles: [...CUSTOMER_ROLES] },
    ),
  ],
  // F25: a connection timeout in the words of a message on the screen, in a paragraph about Teams or signing in (a
  // printer's "connection timed out" has no such words before it).
  'sig.error-timeout': [
    rx(
      String.raw`${ABOUT_TEAMS}\b(?:error|message|says?|shows?|displays?|gives?|gets?|got|see(?:s|ing)?)\b${GAP}{0,40}\bconnection (?:timed out|time-?out)\b`,
      { roles: [...CUSTOMER_ROLES] },
    ),
  ],
  // F26: a name that could not be found, in the words of the screen: "could not find the server", "the host name could not
  // be resolved", in a paragraph about Teams or signing in.
  'sig.error-name-not-resolved': [
    rx(
      String.raw`${ABOUT_TEAMS}\b(?:says?|shows?|displays?|message|error|gets?|got)\b${GAP}{0,40}\b(?:could ?n['’]?t|could not|cannot|can['’]?t|unable to)\s+(?:find|reach|locate|resolve)\s+(?:the\s+|a\s+|that\s+)?(?:server|name|host(?:name)?|address)\b`,
      { roles: [...CUSTOMER_ROLES] },
    ),
    rx(
      String.raw`${ABOUT_TEAMS}\b(?:could ?n['’]?t|could not|cannot|can['’]?t|unable to|failed to|fails? to)\s+(?:be\s+)?(?:resolved?|found|located|look ?up)\b${GAP}{0,30}\b(?:name|host(?:name)?|server|address|domain)\b`,
      { roles: [...CUSTOMER_ROLES] },
    ),
    rx(
      String.raw`${ABOUT_TEAMS}\b(?:server name|host ?name|domain name|dns name|name of the (?:server|host))\b${GAP}{0,30}\b(?:(?:could ?n['’]?t|could not|cannot|can['’]?t|can not) be (?:resolved|found)|not (?:be )?(?:resolved|found)|does ?n['’]?t exist|does not exist|failed to resolve)`,
      { roles: [...CUSTOMER_ROLES] },
    ),
  ],
  // F27: the browser version does the same.
  'sig.web-client-also-fails': [
    rx(
      String.raw`\b(?:web|browser)(?: version| client| app)?\b${GAP}{0,30}\b(?:does|do) the same\b`,
      { roles: [...CUSTOMER_ROLES] },
    ),
  ],
  // F28: the cache was cleared or Teams reinstalled and the outcome is in the same sentence or opens the next one ("same
  // result", "still there"). A question is not crossed.
  'sig.cache-clear-no-effect': [
    rx(
      String.raw`\b(?:clear(?:ed|ing)?|emptied|empty(?:ing)?|deleted?|wiped?|removed?|reset|purged?|reinstall(?:ed|ing)?)\b${SENT}{0,60}\b(?:cache|app ?data|folder|profile|credentials?)\b${SENT}{0,120}\b(?:same (?:result|error|message|thing|problem|code)|nothing changed|no (?:change|difference)|did(?:n['’]?t| not) (?:help|change|fix)|still (?:fails?|failing|there|the same|happens|blocked|asks?|shows?|says?)|exactly (?:as before|the same)|not (?:fixed|helped|resolved))`,
      { roles: [...CUSTOMER_ROLES] },
    ),
    rx(
      String.raw`\b(?:clear(?:ed|ing)?|emptied|empty(?:ing)?|deleted?|wiped?|removed?|reset|purged?|reinstall(?:ed|ing)?)\b${SENT}{0,60}\b(?:cache|app ?data|folder|profile|credentials?)\b${SENT}{0,100}[.!]\s+(?:the )?(?:same|nothing changed|no (?:change|difference)|still|exactly)\b`,
      { roles: [...CUSTOMER_ROLES] },
    ),
  ],
  // F29: clearing or resetting fixed it, in the customer's words or in a resolution note. Only a stated result counts: a
  // request to sign in again, or a failure that came back, is not one.
  'sig.cache-clear-resolved': [
    rx(
      String.raw`\b(?:clear(?:ed|ing)?|emptied|empty(?:ing)?|deleted?|wiped?|reset(?:ting)?|purged?|reinstall(?:ed|ing)?)\b[^\n]{0,60}\b(?:cache|cached data|app ?data|teams folder|folder|profile|broker|credentials?|both)\b[^\n]{0,80}\b(?:fixed|resolved|solved|cured|corrected|worked|works|working)\b`,
    ),
  ],
  // F30: the sessions were revoked and nothing changed, or the same error came back.
  'sig.revoke-sessions-no-effect': [
    rx(
      String.raw`\b(?:revoked?|revoking|invalidated?)\b[^\n]{0,60}\b(?:sessions?|tokens?)\b[^\n]{0,120}\b(?:same (?:thing|result|failures?|error|message|problem|code)|nothing changed|no (?:change|difference)|did ?n['’]?t help|still (?:fail|failing|say|says|get|got|the same|happening))`,
      { roles: [...CUSTOMER_ROLES] },
    ),
    rx(
      String.raw`\bsessions? (?:were |was )?revoked\b[^\n]{0,120}\b(?:(?:got|get|gets|see|saw|had|have)\s+[^.\n]{0,25}\bagain\b|same (?:thing|result|error|message|code)|nothing changed|no change|still (?:fail|failing|say|says))`,
      { roles: [...CUSTOMER_ROLES] },
    ),
  ],
};

/**
 * Pieces of the server-side families below. As above, each one is bounded and nests no repetition.
 */
/** Like `GAP`, and a full stop in front of a word character stays inside the sentence (a host name such as login.microsoftonline.com). */
const HOST_GAP = String.raw`(?:[^.\n]|\.(?=\w))`;
/** A verb that is denied, with or without the apostrophe: "did not", "doesn't", "never". */
const NOT_DONE = String.raw`(?:(?:do|does|did|is|are|was|were|has|have|had|ca|could)n['’]?t|(?:do|does|did|is|are|was|were|has|have|had|can|could) not|cannot|never)`;
/** Where an identity service keeps the record of a sign-in, in the words engineers use for it. */
const SIGNIN_LOG = String.raw`(?:sign[- ]?in ?logs?|entra(?: id)?|azure ad|the logs?)`;
/** One line of such a log, in the singular or the plural. */
const LOG_ROW = String.raw`(?:records?|rows?|entr(?:y|ies)|events?|traces?|hits?|lines?)`;
/** "no", "zero" and "not a single": what is said to be missing. */
const NO_ANY = String.raw`(?:no|zero|0|not (?:a single|one))`;
/**
 * The modality cues know "no" and "none", not a count of nothing, so a statement of what is there must not start right after
 * "zero" or "0" (and the words that follow its verb are checked where that matters).
 */
const NOT_ZERO = String.raw`(?<!\b(?:zero|nil|0 \w{2,8})[^.\n]{0,40})`;
/** A time range is no failure: "the failure window", "the incident period". Put it behind a word such as "failure" or "attempts". */
const NOT_A_RANGE = String.raw`(?!\s+(?:window|period|time ?frame|range|interval)\b)`;
/** A bounded gap of at most `max` characters inside one sentence, as short as it can be. */
const gap = (max: number): string => String.raw`${HOST_GAP}{0,${max}}?`;
/** The same, and it stays inside one clause: no comma, colon or semicolon either. */
const clauseGap = (max: number): string => String.raw`(?:[^.,;:\n]|\.(?=\w)){0,${max}}?`;
/**
 * What an engineer writes after looking at something. A case note is left out on purpose: plans, hypotheses and findings meet
 * there, and the detectors written before these families already read it.
 */
const FINDING_TYPES: typeof LOG_RESULT_TYPES = [
  'query_output',
  'diagnostic_result',
  'escalation_response',
  'engineer_action',
  'engineer_email',
  'resolution_note',
  'log_sample',
];
/** The customer's administrators, who can open the sign-in logs of their own tenant. */
const CUSTOMER_LOG_ROLES = ['customer_admin', 'customer_network_admin'] as const;
const CUSTOMER_LOG_TYPES: typeof LOG_RESULT_TYPES = ['customer_email', 'customer_call'];
/**
 * A statement of what is there, read by the engineer's words: a denial inside it ("no failed rows") counts against it, even
 * when the pattern holds a word such as "zero" that its own look-around needs.
 */
const AS_FOUND: Parameters<typeof rx>[1] = { eventTypes: FINDING_TYPES, negativeContent: false };
/** The same statement with the log named before it or after it, in the one sentence: a phrase that needs a log to be about one. */
const withLog = (statement: string, before = 80, after = 60): string[] => [
  String.raw`\b${SIGNIN_LOG}\b${gap(before)}${statement}`,
  String.raw`${statement}${gap(after)}\b${SIGNIN_LOG}\b`,
];
/**
 * What a test of the network is reported in (the engineer's findings, the validation after a fix, the network
 * administrator's own mail) and who runs one: the engineers and the customer's network administrator, not the helpdesk that
 * passes on what it was told.
 */
const NETWORK_TEST_TYPES: typeof LOG_RESULT_TYPES = [
  ...FINDING_TYPES,
  'validation_result',
  'case_note',
  'customer_email',
  'customer_call',
];
const TESTER_ROLES = [...ENG_ROLES, 'customer_network_admin'] as const;
/** A test result that states what is there: a denial inside its words ("does not time out") counts against it. */
const AS_TESTED: Parameters<typeof rx>[1] = {
  roles: [...TESTER_ROLES],
  eventTypes: NETWORK_TEST_TYPES,
  negativeContent: false,
};
/** A test result whose words are themselves a denial ("did not answer"): the failure it reports. */
const AS_TESTED_DENIAL: Parameters<typeof rx>[1] = { ...AS_TESTED, negativeContent: true };
/** A test as it is run, not the recap of a closed case, which names the cause ("a filter rule sinkholes the CDN names"). */
const AS_TESTED_NOW: Parameters<typeof rx>[1] = {
  ...AS_TESTED,
  eventTypes: NETWORK_TEST_TYPES.filter((type) => type !== 'resolution_note'),
};
/** A name server, as an engineer points at it: a noun, an address (10.30.4.6) or the last part of one (.6). */
const DNS_NOUN = String.raw`(?:resolvers?|dns servers?|name ?servers?|forwarders?)`;
const DNS_REF = String.raw`(?:\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\B\.\d{1,3}\b|\b(?:dns|ns|resolver)-?\d{1,2}\b|\b${DNS_NOUN}\b)`;
/** A proxy node by its name (gbg-prx2, proxy-04, swg3), by its number ("proxy node 3"), by its letter or by its place in the list. */
const PROXY_NODE = String.raw`(?:\b[a-z0-9-]{0,16}(?:prx|proxy|pxy|swg|wsg)[a-z0-9-]{0,10}\d\b|\bproxy (?:node |server )?#?\d{1,2}\b|\bproxy[- ][a-h]\b|\b(?:first|second|third|fourth|fifth|last) proxy\b)`;
/** A node that does not answer, in the affirmative: what a timeout or a drop is called. */
const NODE_FAILS = String.raw`(?:times? out|timed out|timing out|time-?outs?|fail(?:s|ed|ing)?\b(?!\s?over)|drop(?:s|ped|ping)?|hung|hangs?|stall(?:s|ed)?|unresponsive|returns? (?:a )?(?:gateway time-?out|50[234]))`;
/** "All answered normally": the way a test that finds nothing wrong is worded. */
const ALL_FINE = String.raw`(?:normally|fine|(?:the )?(?:correct|right)\w*|every time|okay?|properly|as expected|within|under|identical|\d+ of \d+|(?:ten|five|three|four|two|twenty) of \w+)`;
const ANSWERS = String.raw`(?:answer\w*|respond\w*|repl(?:y|ies|ied)|return\w*|resolve[sd]?|work(?:s|ed)?|succeeded|complet\w+)`;
/** When something changed, as a customer says it: a relative time, a day, "last Thursday", "on Monday night". Not a time of day. */
const WHEN_ANY = String.raw`(?:yesterday|tonight|today|this (?:morning|week|month)|last (?:night|week(?:end)?|month|\w{3,9}day)|on \w{3,9}day|(?:\d+|an?|one|two|three|few) (?:days?|weeks?) ago|recently)`;
/** The parts of a network, in the words a customer uses for them: a change to one of them is a network change. */
const NET_PART = String.raw`(?:dns|resolvers?|dhcp|proxy|proxies|pac file|firewall|gateway|web ?filter\w*|vpn|wan|egress|isp|inspection|rack)`;
/** What was done to them. A removal, a rollback and a restore are not in it: they are what the fix did, not what broke it. */
const NET_DID = String.raw`(?:(?:mov|migrat|switch|chang|replac|upgrad|updat|enabl|deploy|push|appli)ed|added|rolled out|turned on|went live)`;
/** What the access policy is made of, beyond the rule nouns of `ACCESS_RULE`. */
const POLICY_THAT = String.raw`polic(?:y|ies) (?:that|which) (?:requires?|blocks?|enforces?|forces?|mandates?|restricts?)`;
const CA_THING = String.raw`(?:${ACCESS_RULE}|sign-?in frequency|session (?:limit|lifetime|timeout)|token lifetime)`;
const MONTH = String.raw`(?:january|february|march|april|may|june|july|august|september|october|november|december)`;
/** What a customer says when excluding users from a policy changed nothing: "still blocked", "the same error", "no change". */
const NO_EFFECT = String.raw`(?:still (?:blocked|fail\w*|prompted|asked|gets?|getting|seeing|the same|broken|happening)|same (?:error|message|block\w*|result|failure\w*|thing|behaviou?r|pattern|problem|issue|prompt)|(?:failures?|errors?|blocks?|prompts?) (?:continue|persist|remain)\w*)`;
const PRT = String.raw`(?:primary refresh token|prt)`;
/** Where a device's token is told in words. The case note, which sums the case up, is left to the older detectors. */
const PRT_TYPES: typeof LOG_RESULT_TYPES = [
  ...FINDING_TYPES,
  'validation_result',
  ...CUSTOMER_LOG_TYPES,
];
/** A federation server or node, as it is named: AD FS (ADFS03), the STS, the federation farm, the web application proxy. */
const FED_NODE = String.raw`(?:ad ?fs\w{0,10}|sts|federation (?:server|farm|node|service|proxy)|web application proxy)`;
/** Where Microsoft says whether it has an incident. */
const HEALTH_PAGE = String.raw`(?:service health|the (?:service )?status page|the message center|microsoft(?:['’]s)? status)`;
const FED_CLOCK = String.raw`(?:fast|slow|ahead|behind|drift\w*|skew\w*|out of sync|wrong|off by)`;
const IPV4 = String.raw`\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}`;
/** A name server by what it is called: the plain nouns, "the secondary DNS", "ns2". */
const DNS_NOUN_WIDE = String.raw`(?:${DNS_NOUN}|(?:primary|secondary|second|first|backup|internal|upstream|other) dns|ns ?\d)`;
/** More ways of pointing at a proxy node: "PRX-B", "the proxy at 10.1.9.14". */
const PROXY_NODE_MORE = String.raw`(?:\b(?:prx|pxy|swg|wsg|proxy)-[a-h]\b|\bproxy (?:at |on |server |node )?${IPV4}\b)`;
/** A place where people work: "the Lyon branch", "our Porto depot", "the 10.4.8.0/24 subnet". */
const SITE_NOUN = String.raw`(?:office|branch|site|plant|depot|warehouse|building|campus|floor|location|subnet|store)`;
/** The place with its name, never "all of our offices" or "every office": a place that is one among others. */
const SITE_NAME = String.raw`(?:(?:the|our|this) )?(?!(?:all|every|each|any|both|most)\b)(?:[\p{L}\d./-]{2,20} )?`;
/** The same with the name required ("the Lyon branch", never just "our office"). */
const SITE_NAMED = String.raw`(?:(?:the|our|this) )?(?!(?:all|every|each|any|both|most|our|the|this|that|my|your|a|an|other|same|office|site|branch|floor)\b)[\p{L}\d./-]{2,20} `;
const SITE_GROUP = String.raw`(?:everyone|everybody|all|sales|finance|we|they)`;
const SITE_TROUBLE = String.raw`(?:cannot|can['’]?t|unable|locked out|stuck|fail\w*|errors?|affected|down|(?:gets?|have|has) (?:it|the (?:error|problem|issue)))`;
/** The places that are not affected, said in the plural or as the rest. */
const SITE_REST = String.raw`(?:offices|branches|sites|plants|depots|warehouses|buildings|campuses|floors|locations|subnets|stores|regions|networks|company|rest)`;
const SITE_FINE = String.raw`(?:(?:(?:is|are) )?(?:fine|ok|okay|good|unaffected|normal(?:ly)?|not (?:affected|impacted)|working)|works?\b|no (?:issues?|problems?|trouble)|nothing)`;
/** What a customer does to a Teams installation to repair it, and what it was done to. */
const CC_ACT = String.raw`(?:clear(?:ed|ing)?|delet(?:e|ed|ing)|wip(?:e|ed|ing)|remov(?:e|ed|ing)|reset(?:ting)?|re-?install(?:ed|ing|ation)?|clean install|installed it again)`;
const CC_OBJ = String.raw`(?:cache|folder|profile|credentials?|teams|app|client|data)`;
const CC_OBJ_STRICT = String.raw`(?:cache|folder|profile|credentials?)`;
/** The browser and the website: where Teams runs without the desktop client. */
const WEB_WHERE = String.raw`(?:browser|web|website|teams web|chrome|edge|firefox|safari|incognito|inprivate|teams\.microsoft\.com)`;

/**
 * Wording families for the signals about the server side: what the logs and the infrastructure show (name servers, proxy
 * nodes, federation, device tokens, service health) and what changed in the access policy. Kept apart from the maps above
 * so that two authors can add families at the same time; read both when looking for what detects a signal. The same
 * rules hold: a family is a way of saying a thing, never a list of the sentences that failed; every family has
 * look-alike sentences it must not read in `test/detector-families-server-side.test.ts`; gaps are bounded.
 */
const WORDING_FAMILIES_SERVER_SIDE: Readonly<Record<string, readonly SignalDetector[]>> = {
  // A failed row that is not there, said in the many ways engineers say it: the row noun in the singular or the plural, the
  // log as the subject ("held nothing", "are clean"), the attempt as the subject ("do not appear"), or the service never reached.
  'sig.no-server-side-failure-records': [
    ...[
      String.raw`\b${NO_ANY}\b[\w -]{0,20}?\b(?:fail(?:ed|ures?|ing)|errors?|blocked|rejected)\b[\w -]{0,16}?\b${LOG_ROW}\b`,
      String.raw`\b${NO_ANY}\b[\w -]{0,12}?\b(?:sign-?in|log-?in|logon|authentication)\b[\w -]{0,12}?\b${LOG_ROW}\b`,
      String.raw`\b${NO_ANY}\b[\w -]{0,12}?\b(?:matching|corresponding|relevant)\b[\w -]{0,12}?\b${LOG_ROW}\b${gap(80)}\b(?:fail\w*|attempts?|sign-?ins?|users?|${SIGNIN_LOG})\b${NOT_A_RANGE}`,
      String.raw`\b${NO_ANY} (?:[\w-]+ )?${LOG_ROW}\b${gap(40)}\b(?:for|of|from|at|around|during|matching)\b${gap(40)}\b(?:attempts?|failures?|users?|sign-?ins?|them|those|these)\b${NOT_A_RANGE}`,
      String.raw`\b(?:could ?n['’]?t|could not|did ?n['’]?t|did not|cannot|can['’]t|unable to) (?:find|see|locate) (?:any|an?|one)\b[\w -]{0,30}?\b${LOG_ROW}\b${gap(60)}\b(?:fail\w*|attempts?|users?|${SIGNIN_LOG})\b${NOT_A_RANGE}`,
      String.raw`\b(?:nothing|no (?:[\w-]+ )?(?:failures?|errors?|failed (?:sign-?ins?|attempts?|logins?)))\b (?:is |was |were |are |has been |have been |had been )?(?:logged|recorded|captured|registered|written|stored)\b`,
      String.raw`\b(?:never|(?:did|does|do)n['’]?t|(?:did|does|do) not|fail(?:s|ed|ing)? before|stops? before|stopped before)\b${gap(15)}\b(?:even )?(?:reach(?:es|ed|ing)?|get(?:s|ting)? (?:as far as|to|there)|got (?:as far as|to|there)|make it to|made it to|arriv(?:e|es|ed|ing) (?:at|in))\b${gap(30)}\b(?:entra|azure ad|the identity (?:provider|service|platform)|the (?:sign-?in |authentication |auth )?service|microsoft(?: 365| entra)?|the tenant)\b`,
    ].map((pattern) => rx(pattern, { eventTypes: FINDING_TYPES })),
    // With the log named in the sentence: an engineer's, and the customer administrator's who looked into it as well.
    ...[
      String.raw`\b${SIGNIN_LOG}\b${clauseGap(30)}\b(?:held|holds?|had|has|have|contain(?:s|ed)?|show(?:s|ed)?|list(?:s|ed)?|return(?:s|ed)?|gave|gives?|came back|comes back|turned up|are|is|were|was|look(?:s|ed)?)\b${clauseGap(12)}\b(?:nothing|none|(?:no|zero) (?:[\w-]+ )?(?:${LOG_ROW}|failures?|errors?|results?|matches)|empty|blank|clean|quiet)\b`,
      String.raw`\b${SIGNIN_LOG}\b${gap(60)}: ?(?:nothing|none|nil|(?:no|zero) (?:[\w-]+ )?(?:${LOG_ROW}|failures?|errors?|hits|results?|matches))\b`,
      String.raw`\b(?:nothing|nil|none|(?:no|zero) (?:[\w-]+ )?(?:${LOG_ROW}|failures?|errors?|hits|results?|matches|sign|evidence|mention))\b${gap(45)}\b(?:in|on|from|within|inside)\b${gap(14)}\b${SIGNIN_LOG}\b(?!${HOST_GAP}{0,60}\bsince (?:the|your|our|this) (?:change|fix|removal|update|workaround)\b)`,
      String.raw`\b(?:attempts?|sign-?ins?|failures?|requests?|them|these|those|they)\b${gap(40)}\b${NOT_DONE} (?:even )?(?:appear|show(?: up)?|be (?:found|seen|listed|logged|recorded)|exist|registered|visible|listed|recorded|logged|found|present|there)\b${gap(40)}\b${SIGNIN_LOG}\b`,
      String.raw`\bnone of (?:them|these|those|the [\w ]{0,20}?(?:attempts|failures|users|sign-?ins))\b${gap(40)}\b(?:appear|show(?:s)?(?: up)?|are|were|is|was|exist|found|listed|logged|recorded|visible|present)\b${gap(30)}\b${SIGNIN_LOG}\b`,
      String.raw`\b${SIGNIN_LOG}\b${clauseGap(20)}\b${NOT_DONE} (?:log|record|show|list|contain|have|hold|see)\b${clauseGap(20)}\b(?:anything|any (?:[\w-]+ )?${LOG_ROW}|a single (?:row|record|entry|event))`,
      String.raw`\b${SIGNIN_LOG}\b${gap(40)}\b(?:found|find|saw|see|got|get|returned|there (?:is|are|was|were))\b${gap(6)}\b(?:nothing|(?:no|zero|0) (?:[\w-]+ )?(?:${LOG_ROW}|failures?|errors?|results?|matches))`,
      String.raw`\b${SIGNIN_LOG}\b${clauseGap(10)}\bnever (?:saw|received|got|logged|recorded|heard)\b`,
      ...withLog(
        String.raw`\b(?:no|zero|not (?:a single|one)) (?:failed|failing|blocked|unsuccessful) (?:sign-?ins?|attempts?|logins?)\b(?!${gap(60)}\bsince (?:the|your|our|this) (?:change|fix|removal|update|workaround)\b)`,
        60,
        50,
      ),
      ...withLog(
        String.raw`\b(?:0|zero) (?:[\w-]+ )?(?:failures?|failed (?:sign-?ins?|attempts?|logins?)|errors?)\b(?!${gap(60)}\bsince (?:the|your|our|this) (?:change|fix|removal|update|workaround)\b)`,
        60,
        50,
      ),
    ].flatMap((pattern) => [
      rx(pattern, { eventTypes: FINDING_TYPES }),
      rx(pattern, { roles: [...CUSTOMER_LOG_ROLES], eventTypes: CUSTOMER_LOG_TYPES }),
    ]),
  ],
  // A failed row that is there: at each of the times given, one for each user, "matching" the attempts, or listed by the log.
  'sig.server-side-failure-records-present': [
    ...[
      String.raw`\b(?:fail(?:ed|ures?|ing)|blocked|rejected|interrupted|denied)\b${NOT_ZERO}${gap(25)}\b(?:rows?|records?|entr(?:y|ies)|events?)\b${gap(40)}\b(?:at|for|around|within|on|in)\b${gap(12)}\b(?:each|every|all|those|these|the|that|their|your) (?:of )?(?:the )?(?=[\w -]{0,20}\b(?:times?|moments?|timestamps?)\b)`,
      String.raw`\b(?:each|every|all|both)\b${NOT_ZERO}${gap(30)}\b(?:has|have|had|show(?:s|ed)?|with)\b${gap(10)}\b(?:an? |one |at least one |several |multiple |the )?(?!(?:zero|nil|0)\b)(?:[\w-]+ )?(?:fail(?:ed|ures?|ing)|blocked|rejected|interrupted)\b${gap(30)}\b(?:rows?|records?|entr(?:y|ies)|events?)\b`,
      String.raw`\b(?:found|find|see|saw|there (?:is|are|was|were)|have|has|had|returned|show(?:s|ed)?)\b${NOT_ZERO}${gap(12)}\b(?:matching|corresponding)\b[\w -]{0,24}?${LOG_ROW}\b`,
      String.raw`\b(?:matching|corresponding)${NOT_ZERO} (?:[\w-]+ )?${LOG_ROW}\b${gap(20)}\b(?:were|are|was|is) (?:found|present|there|returned|logged)\b`,
      String.raw`\bthere (?:is|are|was|were)\b${NOT_ZERO}${gap(10)}\b(?:an? |one |several |multiple |\d+ )?(?!(?:zero|nil|0)\b)(?:[\w-]+ )?(?:fail(?:ed|ures?)|blocked|rejected)\b${gap(16)}\b(?:rows?|records?|entr(?:y|ies)|events?)\b`,
      String.raw`\b(?:fail(?:ed|ure)|blocked|rejected)\b${NOT_ZERO}[\w -]{0,16}?\b(?:rows?|records?|entr(?:y|ies)|events?)\b${gap(12)}\b(?:exists?|is present|are present|was found|were found|is there|are there|appears?|shows? up|is logged|are logged|is recorded|are recorded)\b`,
    ].map((pattern) => rx(pattern, AS_FOUND)),
    // What a failed attempt or sign-in is only when the sentence says that the log holds it.
    ...[
      ...withLog(
        String.raw`\b(?:fail(?:ed|ures?|ing)|blocked|rejected|interrupted|denied)\b${NOT_ZERO}${gap(25)}\b(?:attempts?|sign-?ins?|requests?)\b${gap(40)}\b(?:at|for|around|within|on|in)\b${gap(12)}\b(?:each|every|all|those|these|the|that|their|your) (?:of )?(?:the )?(?=[\w -]{0,20}\b(?:times?|moments?|timestamps?)\b)`,
      ),
      ...withLog(
        String.raw`\b(?:each|every|all|both)\b${NOT_ZERO}${gap(30)}\b(?:has|have|had|show(?:s|ed)?|with)\b${gap(10)}\b(?:an? |one |at least one |several |multiple |the )?(?!(?:zero|nil|0)\b)(?:[\w-]+ )?(?:fail(?:ed|ures?|ing)|blocked|rejected|interrupted)\b${gap(30)}\b(?:attempts?|sign-?ins?)\b`,
        100,
        40,
      ),
      ...withLog(
        String.raw`\b(?:every|each|all|both)\b${NOT_ZERO}${gap(35)}\b(?:attempts?|failures?|sign-?ins?|rows?)\b${gap(20)}\b(?:is|are|was|were)\b${gap(6)}\b(?:there|logged|recorded|listed|visible|present|found)\b`,
        100,
        20,
      ),
    ].map((pattern) => rx(pattern, AS_FOUND)),
    rx(
      String.raw`\b${SIGNIN_LOG}\b${gap(30)}\b(?:hold|holds|held|have|has|had|contain(?:s|ed)?|show(?:s|ed)?|list(?:s|ed)?|record(?:s|ed)?|log(?:s|ged)?|include[sd]?|display(?:s|ed)?|confirm(?:s|ed)?|returned|returns?)\b(?!\s+(?:zero|nil|0)\b)${gap(20)}\b(?:fail(?:ed|ures?|ing)|blocked|rejected|interrupted|errors?)\b`,
      AS_FOUND,
    ),
    // A count of failed rows, or the engineer's finding them: "7 failed rows for the UPNs", "I can see each of the failures in Entra".
    ...[
      ...withLog(
        String.raw`(?<!\b(?:of|the|these|those|all|only) )\b(?:[1-9]\d{0,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several|multiple|many) (?:[\w-]+ )?(?:fail(?:ed|ures?|ing)|blocked|rejected|interrupted)(?: sign-?ins?| attempts?| logins?| rows?| records?| entries| events?)?\b`,
        60,
        50,
      ),
      String.raw`\b(?:found|see|saw|counted|spotted|list(?:s|ed)?|show(?:s|ed)?|there (?:are|were))\b${NOT_ZERO}${gap(6)}\b(?:[1-9]\d{0,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several|multiple|many) (?:[\w-]+ )?failed (?:sign-?ins?|attempts?|logins?|rows?|records?|entries|events?)\b`,
      String.raw`\b(?:I|we) (?:can |could )?(?:see|saw|found|find|spotted|located)\b${gap(20)}\b(?:each|every|all|both|the)\b${gap(20)}\b(?:failures?|failed (?:attempts?|sign-?ins?|logins?)|attempts?)\b${gap(40)}\b(?:in|on|from)\b${gap(10)}\b${SIGNIN_LOG}\b`,
      String.raw`\b(?:attempts?|sign-?ins?|failures?|them|these|those|they)\b${gap(40)}\b(?:show(?:s)? up|appear(?:s|ed)?|(?:are|were) (?:listed|logged|recorded|visible))\b${gap(6)}\b(?:as|with|in)\b${gap(10)}\b(?:fail\w*|errors?|blocked|interrupted)\b`,
      String.raw`\bone (?:row|record|entry|event) per (?:attempt|failure|sign-?in|user)\b`,
    ].map((pattern) => rx(pattern, AS_FOUND)),
  ],
  // An audit of policy changes that finds nothing in the failure window: none of its rows inside it, or only old ones, which
  // are background.
  'sig.policy-events-outside-failure-window': [
    String.raw`\b(?:audit|polic(?:y|ies)|conditional access|configuration|change log)\b${gap(120)}\b(?:zero|no|0|none)\b${gap(40)}\b(?:in|inside|within|during)\b${gap(20)}\b(?:failure|incident|outage|problem|failing|affected|reported)\b[\w -]{0,12}?\b(?:window|period|time ?frame|time range|interval)\b`,
    String.raw`\b(?:audit|polic(?:y|ies)|conditional access|configuration)\b${gap(100)}\boutside (?:of )?(?:the )?[\w ]{0,20}?\b(?:window|period|time ?frame|time range)\b`,
    String.raw`\b(?:only|closest|nearest|last|latest|most recent)\b${gap(30)}\b(?:polic(?:y|ies)|audit|configuration)\b${gap(60)}\b(?:dated|from|in|on)\b${gap(25)}\b(?:january|february|march|april|may|june|july|august|september|october|november|december|\d+ (?:weeks?|months?) ago)\b${gap(80)}\b(?:unrelated|background|nothing to do with|not related|irrelevant)\b`,
  ].map((pattern) => rx(pattern, { eventTypes: FINDING_TYPES })),
  // A session or token that ran out, in the words of the log and of the client: a code, "the refresh token has expired", "session
  // expired", and how an engineer explains it ("a password change ends the existing sessions").
  'sig.token-expiry-errors': [
    rx(String.raw`\bAADSTS(?:70008|70043|70044|700082|700084|50173|50132|50133)\b`),
    rx(
      String.raw`\b(?:sessions?|tokens?|refresh tokens?|access tokens?|grants?)\b (?:has |had |have |is |are |was |were |got |gets )?(?:been )?expired\b`,
    ),
    rx(String.raw`\bexpired (?:refresh |access |sign-?in )?(?:tokens?(?!-)|sessions?|grants?)\b`),
    // The mechanism, as an engineer explains it: "a password change ends the existing sessions", "ends every session".
    rx(
      String.raw`\b(?:ends|invalidates|expires|revokes|terminates|kills)\b${gap(10)}\b(?:every|all|each|the existing|existing|their) (?:[\w-]+ )?(?:sessions?|(?:refresh )?tokens?)\b`,
    ),
  ],
  // Conditional Access or MFA that stopped a sign-in, as the log shows it: a code, "the policy is blocking them", "the rows show
  // the policy applied", "the result interrupted because multi-factor is required".
  'sig.mfa-ca-events-in-logs': [
    rx(
      String.raw`\bAADSTS(?:50076|50074|50072|50079|50097|50131|50158|53000|53001|53002|53003|53004|530003|530032)\b`,
      { eventTypes: FINDING_TYPES },
    ),
    ...[
      String.raw`\b(?:conditional access|ca)\b${gap(20)}\b(?:polic(?:y|ies)|rule)\b${gap(50)}\b(?:(?:is|are|was|were|has been|have been) (?:blocking|denying|rejecting|interrupting)|(?:blocked|denied|rejected|interrupted) (?:them|those|these|all|every|each|their|the))\b`,
      String.raw`\b(?:rows?|entries|records?|events?|results?)\b${gap(40)}\b(?:show(?:s|ed)?|list(?:s|ed)?|say|says|indicate[sd]?)\b${gap(30)}\b(?:the |a )?(?:conditional access |ca |mfa )?polic(?:y|ies)\b${gap(25)}\b(?:applied|enforced|blocked|triggered|blocking|failed)\b`,
      String.raw`\b(?:results?|rows?|entries|sign-?ins?|attempts?|events?)\b${gap(60)}\b(?:mfa|multi-?factor)\b${gap(25)}\b(?:required|interrupted|not completed|not satisfied|failed|abandoned|challenge)`,
      String.raw`\bconditional ?access ?(?:result|status|outcome)s?\b[^.\n]{0,15}\b(?:failure|failed|blocked|denied|interrupted)\b`,
    ].map((pattern) => rx(pattern, { eventTypes: FINDING_TYPES })),
  ],
  // One name server that does not answer, or answers wrongly: a code (SERVFAIL, NXDOMAIN, a sinkhole) next to an address or a
  // name server, a name server that fails, times out or drops the queries, an address that fails for the sign-in hosts, a
  // filter that blocks them. Whoever tested it: an engineer or the network administrator.
  'sig.resolver-inconsistent': [
    // A code and an address: as a test is run, not as the recap of a closed case explains it.
    ...[
      String.raw`(?:${DNS_REF}|\b${DNS_NOUN_WIDE}\b)${gap(70)}\b(?:servfail|nxdomain|non-?existent domain|sinkhole\w*|server failed|query refused)\b`,
      String.raw`\b(?:servfail|nxdomain|non-?existent domain|sinkhole\w*|server failed|query refused)\b${gap(60)}(?:${DNS_REF}|\b${DNS_NOUN_WIDE}\b)`,
      String.raw`\b(?:dns (?:filter\w*|security)(?: service)?|${DNS_NOUN_WIDE})\b${gap(60)}\b(?:blocks?|blocked|blocking|filter(?:s|ed|ing)|sinkholes?|sinkholed)\b${gap(40)}\b(?:login\.microsoftonline\.com|cdn|aadcdn|microsoft|sign-?in)`,
    ].map((pattern) => rx(pattern, AS_TESTED_NOW)),
    ...[
      String.raw`\b${DNS_NOUN_WIDE}\b${gap(70)}\b(?:fail(?:s|ed|ing)?\b(?!\s?over)|times? out|timed out|timing out|(?:is|was|are|were) (?:silent|unresponsive|down|unreachable)|drop(?:s|ped|ping)?\b${gap(25)}\bquer\w+|refus(?:es|ed|ing)\b${gap(8)}\bquer\w+)`,
      String.raw`\b${DNS_NOUN_WIDE}\b${gap(70)}\b(?:returns?|gives?|answers? with|replies with|resolves? to)\b${gap(8)}\b(?:(?:wrong|bogus|invalid|empty|null|blank|different)\b|0\.0\.0\.0|127\.0\.0\.1|servfail|nxdomain|refused|server failed)`,
      String.raw`${DNS_REF}${gap(40)}\b(?:fail(?:s|ed|ing)?\b(?!\s?over)|unresponsive)\b${gap(30)}\b(?:(?:the )?(?:microsoft|sign-?in|cdn)\b[\w -]{0,12}\b(?:host ?names?|names)|to resolve)`,
      String.raw`${DNS_REF}${gap(40)}\b(?:fail(?:s|ed|ing)?\b(?!\s?over)|unresponsive)\b${gap(40)}\b(?:for|on|with|resolving)\b${gap(25)}\b(?:[\w-]+\.(?:microsoftonline|windows|live|office|office365|msauth|msftauth)\.\w+|(?:the )?sign-?in (?:host ?names?|names|hosts?|endpoints?))`,
      String.raw`${DNS_REF}${gap(40)}\b(?:fail(?:s|ed|ing)?\b(?!\s?over)|unresponsive|times? out|timed out)\b${gap(20)}\b(?:(?:\w+|\d+) (?:times? )?out of (?:\w+|\d+)|\d+ (?:of|in) \d+|half (?:of )?(?:the|them|all)|every (?:other|second|third) (?:time|query|lookup|try|attempt|request))\b`,
    ].map((pattern) => rx(pattern, AS_TESTED)),
    ...[
      String.raw`\b${DNS_NOUN_WIDE}\b${gap(70)}\b(?:(?:did|does|do)(?:n['’]t| not) (?:answer|respond|reply|resolve)|not (?:answering|responding|replying)|(?:could ?n['’]?t|could not|cannot|can['’]t|unable to) resolve|stays? silent|no answers?)`,
      String.raw`\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b${gap(60)}\b(?:(?:did|does|do)(?:n['’]t| not) (?:answer|reply|resolve)|not (?:answering|replying)|(?:could ?n['’]?t|could not|cannot|can['’]t|unable to) resolve|no answers?)`,
    ].map((pattern) => rx(pattern, AS_TESTED_DENIAL)),
  ],
  // Every name server answers: "all three answered every time", "both servers resolve the sign-in hosts normally", "DNS is fine",
  // "no DNS problems". An engineer's word, or the network administrator's own test; a dashboard's colour is not a test.
  'sig.resolvers-consistent': [
    ...[
      String.raw`\b(?:all|every|each|both)\b(?! (?:the )?other)${gap(14)}\b${DNS_NOUN}\b${gap(40)}\b${ANSWERS}\b${gap(50)}\b${ALL_FINE}\b(?!${gap(40)}\bexcept\b)`,
      String.raw`\b(?:all|every|each|both|the (?:two|three|four|five))\b(?! (?:the )?other)${gap(20)}\b(?:${DNS_NOUN}|ns ?\d)\b${gap(60)}\b${ANSWERS}\b${gap(40)}\b(?:the )?(?:same|identical|consistent\w*|correct\w*|fine|normally|every (?:time|query|lookup|request)|within|(?:in )?under)\b(?!${gap(40)}\bexcept\b)`,
      String.raw`\b${DNS_NOUN}\b[^\n]{0,140}?[.!?] (?:all|both) (?:three|two|four|five|of them)\b${gap(10)}\b(?:answer\w*|respond\w*|repl(?:y|ies|ied)|worked|resolved)\b${gap(30)}\b(?:every time|normally|fine|correct\w*|within|in under|each time)`,
      String.raw`\b${DNS_NOUN}\b${gap(100)}[.;!?] (?:all|both|each|they all|every one)(?: (?:three|two|four|five|of them))?\b${gap(10)}\b(?:answer\w*|respond\w*|repl(?:y|ies|ied)|return\w*|worked|resolved?|resolves)\b${gap(30)}\b(?:every time|normally|fine|correct\w*|within|in under|each time|the same)\b`,
      String.raw`\b${IPV4}\b${gap(15)}\band\b${gap(5)}\b${IPV4}\b${gap(40)}\b${ANSWERS}\b${gap(30)}\b(?:identical(?:ly)?|the same|correct\w*|fine|normally|equal\w*|consistent\w*)\b`,
      String.raw`\b(?:${DNS_NOUN}|(?:primary|secondary|first|second|backup) dns)\b${gap(15)}\bboth\b${gap(10)}\b${ANSWERS}\b${gap(30)}\b(?:the )?(?:right|correct\w*|same|identical(?:ly)?|fine|normally)\b`,
      String.raw`\b(?:dns|resol\w+|name resolution)\b${gap(60)}\b(?:both|all|each|every)\b${gap(8)}\bservers?\b${gap(15)}\b${ANSWERS}\b`,
    ].map((pattern) => rx(pattern, AS_TESTED)),
    rx(
      String.raw`\b(?:dns|name) resolution\b${gap(8)}\b(?:is|are|was|were|looks?|looked|works?|worked)\b${gap(12)}\b(?:fine|healthy|ok|okay|normal|good|clean|in order|working)\b`,
      { roles: [...ENG_ROLES], eventTypes: NETWORK_TEST_TYPES, negativeContent: false },
    ),
    rx(
      String.raw`\b(?:dns|name resolution|the resolvers?)\b${gap(8)}\b(?:is|are|was|were|looks?|looked|seems?|seemed|works?|worked|checks? out)\b${gap(12)}\b(?:fine|healthy|ok|okay|normal|good|clean|in order|working)\b`,
      { roles: [...ENG_ROLES], eventTypes: NETWORK_TEST_TYPES, negativeContent: false },
    ),
    rx(String.raw`\b(?:dns|name resolution)\b${gap(6)}\b(?:checks?|checked) out\b`, {
      roles: [...ENG_ROLES],
      eventTypes: NETWORK_TEST_TYPES,
      negativeContent: false,
    }),
    rx(
      String.raw`\b(?:succeed(?:s|ed)?|pass(?:es|ed)?|work(?:s|ed)?|answer(?:s|ed)?|resolve[sd]?|respond(?:s|ed)?)\b${gap(20)}\b(?:on|for|against|from|across|with)\b${gap(6)}\b(?:all|both|every|each)\b(?! (?:the )?other)${gap(14)}\b${DNS_NOUN}\b`,
      AS_TESTED,
    ),
    ...[
      String.raw`\bno (?:dns|name[- ]resolution|resolver)\b${gap(25)}\b(?:issues?|problems?|errors?|failures?|faults?)\b`,
      String.raw`\bno (?:real |significant |visible |noticeable )?differences?\b${gap(8)}\bbetween\b${gap(15)}\b(?:${DNS_NOUN}|ns ?\d)\b`,
      String.raw`\b(?:no|zero|0) (?:servfail|nxdomain)s?\b${gap(40)}\b(?:from|on|for|across|at)\b${gap(15)}\b(?:any|all|every|each|either|both|the)\b${gap(10)}\b${DNS_NOUN}\b`,
      String.raw`\b(?:all|every|each|both)\b(?! (?:the )?other)${gap(14)}\b${DNS_NOUN}\b${gap(40)}\b${ANSWERS}\b${gap(30)}\bwithout (?:a |any )?(?:servfail|nxdomain|errors?|failures?|timeouts?)\b`,
    ].map((pattern) => rx(pattern, AS_TESTED_DENIAL)),
  ],
  // One proxy node that does not answer: its name (gbg-prx2, proxy-04, "proxy node 3") next to a timeout or a drop, "one proxy
  // server out of four times out", "node 3 timed out" in a list of the proxy nodes.
  'sig.proxy-node-inconsistent': [
    ...[
      String.raw`${PROXY_NODE}${gap(60)}\b${NODE_FAILS}\b`,
      String.raw`${PROXY_NODE_MORE}${gap(60)}\b${NODE_FAILS}\b`,
      String.raw`\b(?:one|1|a single|only one)\b${gap(8)}\bprox(?:y|ies)(?: nodes?| servers?| gateways?)?\b${gap(60)}\b${NODE_FAILS}\b`,
      String.raw`\bone of (?:the |our )?(?:two|three|four|five|six|seven|eight|\d+) prox(?:y|ies)(?: nodes?| servers?)?\b${gap(40)}\b${NODE_FAILS}\b`,
      String.raw`\b(?:only|just) (?:the |our )?[a-z]+ (?:proxy|gateway)\b${gap(30)}\b${NODE_FAILS}\b`,
      String.raw`\bprox(?:y|ies)(?: farm| cluster| pool)?\b${gap(40)}\b(?:one|1|a single|a)\b${gap(15)}\b(?:node|member|server)\b${gap(30)}\b${NODE_FAILS}\b`,
      String.raw`\bprox(?:y|ies)\b${gap(60)}\b${NODE_FAILS}\b${gap(60)}\bthe (?:other|others|rest|remaining)\b`,
      String.raw`\bproxy (?:nodes?|servers?|pool|cluster)\b${gap(80)}\bnode ?\d{1,2}\b${gap(40)}\b${NODE_FAILS}\b`,
      String.raw`\bnode ?\d{1,2}\b${gap(20)}\bproxy (?:pool|cluster|farm)\b${gap(40)}\b${NODE_FAILS}\b`,
    ].map((pattern) => rx(pattern, AS_TESTED)),
    ...[
      String.raw`${PROXY_NODE}${gap(60)}\b(?:not (?:responding|answering)|(?:did|does|do)(?:n['’]t| not) (?:respond|answer|reply))\b`,
      String.raw`\b(?:one|1|a single|only one)\b${gap(8)}\bprox(?:y|ies)(?: nodes?| servers?| gateways?)?\b${gap(60)}\b(?:not (?:responding|answering)|(?:did|does|do)(?:n['’]t| not) (?:respond|answer|reply))\b`,
      String.raw`\bprox(?:y|ies)\b${gap(60)}\b(?:(?:did|does|do)(?:n['’]t| not) (?:respond|answer|reply)|not (?:responding|answering))\b${gap(20)}\bthe (?:others?|rest|remaining)\b`,
    ].map((pattern) => rx(pattern, AS_TESTED_DENIAL)),
  ],
  // Every proxy node answers: "all four proxy nodes respond normally", "the proxy test: all three nodes answered within a
  // second", "none of the proxies timed out", "no timeouts through any proxy".
  'sig.proxy-nodes-consistent': [
    ...[
      String.raw`\b(?:all|every|each|both)\b(?! (?:the )?other)${gap(14)}\b(?:proxy|proxies|proxy (?:nodes?|servers?))\b${gap(30)}\b${ANSWERS}\b${gap(40)}\b${ALL_FINE}\b(?!${gap(40)}\bexcept\b)`,
      String.raw`\bproxy\b${gap(60)}\b(?:all|every|each|both)\b(?! (?:the )?other)${gap(10)}\bnodes?\b${gap(30)}\b${ANSWERS}\b${gap(40)}\b${ALL_FINE}\b`,
      String.raw`\b(?:all|every|each|both)\b(?! (?:the )?other)${gap(14)}\b(?:proxy|proxies|proxy (?:nodes?|servers?))\b${gap(40)}\b(?:answer\w*|respond\w*|repl(?:y|ies|ied)|return\w*|work\w*|succeed\w*|pass\w*|complet\w+)\b${gap(40)}\b(?:200|ok|okay|success\w*|fine|normally|correct\w*|within|under|every time|as expected|the same|equally|tests?|checks?|probes?)\b`,
      String.raw`\bprox(?:y|ies)\b${gap(50)}\b(?:behav\w+|perform\w*|respond\w*|answer\w*)\b${gap(10)}\b(?:the same|identically|equally|alike|similarly|consistently)\b`,
      String.raw`${PROXY_NODE}${gap(60)}\ball\b${gap(8)}\b(?:succeeded|answered|responded|worked|passed|returned)\b`,
    ].map((pattern) => rx(pattern, AS_TESTED)),
    ...[
      String.raw`\b(?:no|zero|none of)\b${gap(25)}\b(?:proxy|proxies)\b${gap(20)}\b(?:times? out|timed out|failed|fail|dropped|timeouts?)\b`,
      String.raw`\b(?:each|every|all|both)\b${gap(10)}\bprox(?:y|ies)(?: nodes?| servers?)?\b${gap(40)}\b(?:none of (?:them|the nodes|these|the proxies)|no (?:one|node|proxy)|neither|nothing)\b${gap(15)}\b(?:times? out|timed out|failed|fail|dropped|stalled|hung|timeouts?)\b`,
      String.raw`\bprox(?:y|ies)\b${gap(80)}\b(?:no|not a single) (?:bad|faulty|failing|broken|slow|odd|outlier|misbehaving) (?:node|proxy|proxies)\b`,
      String.raw`\b(?:no|zero) (?:timeouts?|time-?outs?|failures?|errors?|drops?)\b${gap(30)}\b(?:through|on|from|at|via|across)\b${gap(15)}\b(?:any|all|every|each|the|a)\b${gap(8)}\b(?:proxy|proxies|nodes?)\b`,
      String.raw`\b(?:all|every|each|both)\b(?! (?:the )?other)${gap(14)}\b(?:proxy|proxies|proxy (?:nodes?|servers?))\b${gap(30)}\b${ANSWERS}\b${gap(30)}\bwithout (?:a |any )?(?:timeouts?|time-?outs?|errors?|failures?|drops?)\b`,
    ].map((pattern) => rx(pattern, AS_TESTED_DENIAL)),
  ],
  // A change to the customer's network, told by the customer in its own words: what was moved, replaced, upgraded, enabled or
  // renewed, and when ("last Thursday", "on Monday night"). A time of day is not a when: it is what a fix is dated with.
  'sig.recent-network-change-reported': [
    ...[
      String.raw`\b${NET_PART}\b${gap(50)}\b${NET_DID}\b${gap(40)}\b${WHEN_ANY}\b`,
      String.raw`\b${NET_DID}\b${gap(40)}\b${NET_PART}\b${gap(50)}\b${WHEN_ANY}\b`,
      String.raw`\b${WHEN_ANY}\b${gap(60)}\b${NET_DID}\b${gap(40)}\b${NET_PART}\b`,
      String.raw`\b(?:got|received|has|have|had|installed|pushed|renewed|replaced|updated)\b${gap(25)}\b(?:inspection|tls|ssl|proxy|gateway|firewall) certificate\b${gap(30)}\b${WHEN_ANY}\b`,
    ].map((pattern) => rx(pattern, { roles: [...CUSTOMER_ROLES] })),
    ...[
      String.raw`\b(?:new|extra|additional)\b${gap(25)}\b(?:rule|category|filter|exception)\b${gap(70)}\b(?:turned on|switched on|enabled|activated|added|created|pushed|deployed|put in place)\b${gap(30)}\b${WHEN_ANY}\b`,
      String.raw`\b${WHEN_ANY}\b${gap(60)}\b(?:turned on|switched on|enabled|activated|added|created|pushed|deployed|put in place)\b${gap(30)}\b(?:new|extra|additional)\b${gap(25)}\b(?:rule|category|filter|exception)\b`,
    ].map((pattern) => rx(pattern, { roles: ['customer_network_admin'] })),
  ],
  // A change to the access policy, told by the customer (a policy that requires MFA rolled out, the sign-in frequency set) or read
  // by the engineer in the audit log or the recap of the case.
  'sig.recent-ca-change-reported': [
    ...[
      String.raw`\b${WHEN_ANY}\b${gap(60)}\b(?:rolled out|deployed|enabled|introduced|created|turned on|put in place|activated|assigned)\b${gap(30)}\b(?:a |an |the |new )${POLICY_THAT}\b`,
      String.raw`\b(?:rolled out|deployed|enabled|introduced|created|turned on|put in place|activated|assigned)\b${gap(30)}\b(?:a |an |the |new )${POLICY_THAT}\b${gap(60)}\b${WHEN_ANY}\b`,
      String.raw`\b${WHEN_ANY}\b${gap(60)}\b(?:set|changed|updated|reduced|lowered|raised|extended|shortened|increased|configured)\b${gap(40)}\b(?:sign-?in frequency|session (?:limit|lifetime|timeout)|token lifetime)\b`,
      String.raw`\b(?:set|changed|updated|reduced|lowered|raised|extended|shortened|increased|configured)\b${gap(40)}\b(?:sign-?in frequency|session (?:limit|lifetime|timeout)|token lifetime)\b${gap(60)}\b${WHEN_ANY}\b`,
    ].map((pattern) => rx(pattern, { roles: [...CUSTOMER_ROLES] })),
    ...[
      String.raw`\baudit\b${gap(60)}\bpolic(?:y|ies)\b${gap(50)}\b(?:updated|changed|modified|created|edited|added)\b${gap(20)}\b(?:on|last|yesterday|today|this)\b`,
      String.raw`\bnew\b${gap(20)}\b(?:conditional access|ca)\b${gap(8)}\bpolic(?:y|ies)\b${gap(15)}\b(?:was|were|got|has been|had been)\b${gap(4)}\b(?:assigned|created|added|configured|deployed|enabled|applied|introduced|rolled out)`,
    ].map((pattern) => rx(pattern, { roles: [...ENG_ROLES], eventTypes: FINDING_TYPES })),
  ],
  // The access policy left alone: "has not been changed", "nobody touched it", "unchanged", and the audit that finds only old
  // events.
  'sig.ca-config-unchanged': [
    String.raw`\b${CA_THING}\b${gap(30)}\b(?:(?:has|have|had|was|were)(?: ?n['’]?t| not)|never)\b(?: been)? (?:changed|touched|modified|updated|edited|altered|adjusted)\b`,
    String.raw`\b(?:nobody|no one|none of us)\b${gap(20)}\b(?:changed|touched|edited|modified|updated|altered)\b${gap(40)}\b${CA_THING}\b`,
    String.raw`\b${CA_THING}\b${gap(30)}\b(?:remains?|remained|stays?|stayed|is|are|was|were)\b${gap(10)}\b(?:the same|unchanged|untouched|as (?:it|they) (?:was|were)|as before)\b`,
    String.raw`\b(?:the )?(?:only|last|latest|most recent|newest)\b${gap(25)}\b(?:polic(?:y|ies)|ca|conditional access|configuration|access rule)\b${gap(25)}\b(?:changes?|edits?|events?|modifications?|updates?)\b${gap(60)}\b(?:dated|from|in|on|was|were|are|is)\b${gap(20)}\b(?:${MONTH}|\d+ (?:weeks?|months?) ago|last (?:month|year|quarter))\b`,
  ].map((pattern) => rx(pattern)),
  // Leaving users out of the policy changed nothing, said by the customer, in the sentence or the one after: "excluded the three
  // users. They got the same error", "excluded the group, people still blocked".
  'sig.ca-exclusion-no-effect': [
    rx(
      String.raw`\b(?:excluded|excluding|exempted|left out|took out|bypassed)\b[^\n]{0,100}?\b(?:users?|accounts?|groups?|people|staff|members|them|everyone|admins?)\b[^\n]{0,160}?\b${NO_EFFECT}\b`,
      { roles: [...CUSTOMER_ROLES], negativeContent: false },
    ),
    rx(
      String.raw`\b(?:excluded|excluding|exempted|left out|took out|bypassed)\b[^\n]{0,100}?\b(?:users?|accounts?|groups?|people|staff|members|them|everyone|admins?)\b[^\n]{0,160}?\b(?:no (?:change|difference|effect|improvement)|nothing (?:changed|happened)|did ?n['’]?t (?:help|change|fix|work)|made no difference|unchanged)\b`,
      { roles: [...CUSTOMER_ROLES], negativeContent: true },
    ),
    rx(
      String.raw`\bexclusions?\b[^\n]{0,140}?\b(?:still (?:blocked|applied|show\w*|fail\w*|prompt\w*)|same (?:error|message|block\w*)|no (?:change|effect))\b`,
      { roles: [...ENG_ROLES], eventTypes: FINDING_TYPES },
    ),
  ],
  // The primary refresh token of a device that is there: "AzureAdPrt YES", "AzureAdPrt is NO on yours and YES on hers", "has a
  // valid PRT", "shows a fresh primary refresh token".
  'sig.prt-healthy': [
    rx(String.raw`\bAzureAdPrt\b(?:\s*[:=]|\s+(?:is|shows|says|reads))?\s*YES\b`),
    ...[
      String.raw`\bAzureAdPrt\b${gap(25)}\bNO\b${gap(15)}(?:[,;]|\b(?:and|while|but|whereas)\b)${gap(15)}\bYES\b`,
      String.raw`\bAzureAdPrt\b${gap(25)}\bYES\b${gap(15)}(?:[,;]|\b(?:and|while|but|whereas)\b)${gap(15)}\bNO\b`,
    ].map((pattern) => rx(pattern)),
    ...[
      String.raw`\b(?:has|have|had|shows?|showed|with|got|gets?) (?:an? |the )?(?:valid |fresh |healthy |current |new |working )?${PRT}\b(?!${gap(25)}\b(?:expired|stale|invalid|revoked|corrupt\w*)\b)`,
      String.raw`\b${PRT}\b${gap(20)}\b(?:present|healthy|valid|fresh|issued|ok|okay|fine|good|up to date)\b(?!${gap(25)}\b(?:expired|stale|invalid|revoked)\b)`,
      String.raw`\b${PRT}\b${gap(20)}\b(?:is|are|was|were|be|been|got|gets?) (?:\w+ )?(?:there|available|obtained|acquired|received|in place|intact|working|refreshed)\b`,
    ].map((pattern) => rx(pattern, { eventTypes: PRT_TYPES, negativeContent: false })),
    rx(
      String.raw`\b(?:no|without) (?:\w+ )?${PRT}\b${gap(50)}(?:[,;]|\b(?:and|while|but|whereas)\b)${gap(40)}\b(?:(?:does|do)\b(?=\s*(?:[.;,!?\n]|$)|\s+have\b)|(?:has|have|got) one\b|there (?:is|are)\b)`,
      { eventTypes: PRT_TYPES, negativeContent: true },
    ),
  ],
  // The primary refresh token of a device that is gone: "AzureAdPrt is NO", "has lost its PRT", "never got a primary refresh token".
  'sig.prt-missing': [
    rx(String.raw`\bAzureAdPrt\b(?:\s*[:=]|\s+(?:is|shows|says|reads))?\s*NO\b`),
    rx(
      String.raw`\bAzureAdPrt\b${gap(25)}\bYES\b${gap(15)}(?:[,;]|\b(?:and|while|but|whereas)\b)${gap(15)}\bNO\b`,
    ),
    ...[
      String.raw`\b(?:lost|lose|loses|never (?:got|had|received|obtained)|failed to (?:get|obtain|acquire|refresh)|cannot (?:get|obtain|acquire)|can['’]t (?:get|obtain|acquire)|(?:does ?n['’]?t|does not|do not|don['’]t) (?:get|receive|obtain|acquire)|no longer (?:has|have|gets?))\b${gap(20)}\b(?:its |their |the |a )?${PRT}\b`,
      String.raw`\b${PRT}\b${gap(50)}(?:[,;]|\b(?:and|while|but|whereas)\b)${gap(40)}\b(?:(?:does ?n['’]?t|does not|do not|don['’]t)\b(?=\s*(?:[.;,!?\n]|$)|\s+have\b)|(?:has|have|got) none\b|there is none\b)`,
      String.raw`\b${PRT}\b${gap(30)}\b${NOT_DONE} (?:be |been |get |got )?(?:obtained|issued|acquired|received|refreshed|renewed|available|present|there|found)\b`,
    ].map((pattern) => rx(pattern, { eventTypes: PRT_TYPES })),
  ],
  // A federation server that is in error: a signing certificate that expired, a clock that runs fast, tokens it issued that are
  // rejected, a node that is down. Whoever tells it: the engineer, or the customer's administrator who looked.
  'sig.federation-node-error': [
    ...[
      String.raw`\b(?:token[- ]signing|signing|federation|ad ?fs|sts|idp|identity provider|saml)\b${gap(25)}\bcertificates?\b${gap(60)}\b(?:has |have |had |is |was |were |got )?(?:expired|invalid|revoked|about to expire|missing)\b`,
      String.raw`\bexpired\b${gap(30)}\b(?:token[- ]signing|signing|federation|ad ?fs|sts)\b${gap(15)}\bcertificates?\b`,
      String.raw`\b${FED_NODE}\b${gap(40)}\b(?:clock|time)\b${gap(30)}\b${FED_CLOCK}\b`,
      String.raw`\bclock\b${gap(12)}\bof\b${gap(8)}\b${FED_NODE}\b${gap(30)}\b${FED_CLOCK}\b`,
      String.raw`\bfederat\w+\b${gap(60)}\b(?:token|signature|certificate|assertion)\b${gap(50)}\b(?:rejected|invalid|refused|expired)\b`,
      String.raw`\b(?:tokens?|assertions?|signatures?)\b${gap(40)}\b(?:federation|ad ?fs|sts|identity provider|idp)\b${gap(40)}\b(?:rejected|invalid|refused)\b`,
      String.raw`\b${FED_NODE}\b${gap(45)}\b(?:down|unreachable|unresponsive|(?:failing|failed)(?!\s?(?:over|attempts?|sign|log|users?|auth|requests?))|return(?:s|ed|ing)? (?:an? )?(?:http )?(?:5\d\d|errors?)|time[sd]? out|overloaded|crash\w*|stopped|offline)\b`,
      String.raw`\b(?:time|clock) (?:skew|drift|offset)\b${gap(40)}\b(?:on|of|at|between)\b${gap(20)}\b${FED_NODE}\b`,
    ].map((pattern) =>
      rx(pattern, {
        eventTypes: [...FINDING_TYPES, ...CUSTOMER_LOG_TYPES],
        negativeContent: false,
      }),
    ),
    ...[
      String.raw`\b(?:token|signature|certificate|assertion)\b${gap(50)}\bnot (?:yet )?valid\b${gap(40)}\b(?:identity provider|idp|federat\w+|ad ?fs|sts)\b`,
      String.raw`\bfederat\w+\b${gap(60)}\b(?:token|signature|certificate|assertion)\b${gap(50)}\bnot (?:yet )?valid\b`,
      String.raw`\b${FED_NODE}\b${gap(60)}\bnot (?:responding|answering)\b`,
    ].map((pattern) =>
      rx(pattern, {
        eventTypes: [...FINDING_TYPES, ...CUSTOMER_LOG_TYPES],
        negativeContent: true,
      }),
    ),
  ],
  // Microsoft has an incident that matches: "Microsoft has posted an incident for Teams", "the incident explains it", "the
  // incident stays open". The engineer's word; what a customer was told by someone else is not read.
  'sig.service-health-incident': [
    ...[
      String.raw`\b(?:microsoft|${HEALTH_PAGE})\b${gap(40)}\b(?:(?:has |have )?(?:just )?(?:posted|published|declared|opened|logged|listed|reported)|confirm\w*|acknowledg\w*|shows?|lists?)\b${gap(30)}\b(?:an?|the|this)\b${gap(15)}\b(?:incident|outage|advisory|service issue|degradation|disruption|MO\d{5,7}|TM\d{5,7}|EX\d{5,7})\b`,
      String.raw`\b(?:the |this |that )?(?:incident|outage|advisory)\b${gap(40)}\b(?:explains?|matches|fits|is (?:still )?(?:active|ongoing|open)|stays open|remains open|started|began|is being (?:investigated|mitigated)|affects?|impacts?)\b`,
      String.raw`\b(?:an?|the) (?:active |ongoing |open |new )?(?:incident|outage|advisory)\b${gap(30)}\b(?:for|affecting|impacting|concerning)\b${gap(30)}\b(?:teams|sign-?in|entra|authentication|microsoft 365|exchange online)\b`,
    ].map((pattern) => rx(pattern, { roles: [...ENG_ROLES], eventTypes: FINDING_TYPES })),
  ],
  // Microsoft has no incident: "service health is clear", "service health shows nothing", "no incident for Teams", "this is not an
  // outage". The engineer who looked; a dashboard's colour reported by someone else is not read.
  'sig.service-health-clear': [
    rx(
      String.raw`\b${HEALTH_PAGE}\b${gap(30)}\b(?:is|are|looks?|looked|shows?|showed|says?|reports?)\b${gap(8)}\b(?:clear|green|all green|healthy|normal|operational|quiet)\b`,
      {
        roles: [...ENG_ROLES],
        eventTypes: [...FINDING_TYPES, 'validation_result'],
        negativeContent: false,
      },
    ),
    ...[
      String.raw`\b${HEALTH_PAGE}\b${gap(30)}\b(?:is|are|looks?|looked|shows?|showed|says?|reports?|has|have)\b${gap(8)}\b(?:nothing|no (?:\w+ )?(?:incidents?|advisor(?:y|ies)|outages?|issues?|problems?|degradations?|disruptions?))\b`,
      String.raw`\bno (?:active |open |ongoing |known |relevant )?(?:incidents?|advisor(?:y|ies)|outages?|service issues?|degradations?)\b${gap(40)}\b(?:for|affecting|on|about|in|that|which|with)\b${gap(30)}\b(?:teams|sign-?in|entra|authentication|microsoft|m365|office)\b`,
      String.raw`\b(?:this|it|that|there)(?: is|['’]s| was) not (?:an? )?(?:microsoft(?:-side)? |service )?(?:outage|incident|service issue)\b`,
      String.raw`\b${HEALTH_PAGE}\b${gap(30)}\b${NOT_DONE} (?:show|list|have|report|mention|contain)\b${gap(20)}\b(?:an?|any)\b${gap(10)}\b(?:incident|advisory|outage|issue|degradation)\b`,
    ].map((pattern) =>
      rx(pattern, {
        roles: [...ENG_ROLES],
        eventTypes: [...FINDING_TYPES, 'validation_result'],
      }),
    ),
  ],
  // The web version of Teams fails as well: the web, the browser or the site named with a failure and "too", "either", "the same".
  'sig.web-client-also-fails': [
    ...[
      String.raw`\b${WEB_WHERE}\b${gap(40)}\b(?:(?:does|do|did)(?:n['’]?t| not) work|not working|fail(?:s|ed|ing)?|time[sd]? out|timing out|hang(?:s|ing)?|spins?|errors?|break|breaks)\b${gap(25)}\b(?:too|also|either|as well)\b`,
      String.raw`\b(?:in|on|through|via|using|with|from) (?:the |a )?${WEB_WHERE}\b${gap(50)}\b(?:the same|same|identical|exactly the same)\b${gap(6)}\b(?:error|message|screen|code|problem|issue|thing|result|behaviou?r)\b`,
      String.raw`\b(?:desktop|app|client)\b${gap(20)}\band\b${gap(10)}\b(?:the )?(?:web|browser)(?: app| version| client)?\b${gap(15)}\b(?:both|all)\b${gap(10)}\b(?:fail\w*|(?:do|does)(?:n['’]?t| not) work|time[sd]? out)\b`,
      String.raw`\bboth\b${gap(25)}\b(?:web|browser)\b${gap(25)}\b(?:fail\w*|(?:do|does)(?:n['’]?t| not) work|time[sd]? out|errors?)\b`,
      String.raw`\b(?:in|on) (?:the )?(?:browser|web)\b${gap(10)}\b(?:too|also|as well)\b${gap(30)}\b(?:the same|same|identical|exactly)\b`,
      String.raw`\b(?:(?:does|do)(?:n['’]?t| not) work|not working|fail(?:s|ed)?)\b${gap(15)}\b(?:in|on|via|through) (?:the )?(?:browser|web|website)\b${gap(15)}\b(?:either|too|also)\b`,
      String.raw`\bsame (?:thing|error|problem|result|message)\b${gap(40)}\b(?:teams\.microsoft\.com|the web(?:site| version| app)?|the browser|in (?:the )?browser)\b`,
    ].map((pattern) => rx(pattern, { roles: [...CUSTOMER_ROLES] })),
  ],
  // Clearing, deleting, resetting or reinstalling changed nothing: the action, what it was done to, and a result that is the
  // same, still there or "no luck", in the sentence.
  'sig.cache-clear-no-effect': [
    ...[
      String.raw`\b${CC_ACT}\b${SENT}{0,50}\b${CC_OBJ}\b${SENT}{0,100}\bstill (?:fail\w*|there|the same|happens?|happening|broken|blocked|not|asks?|shows?|says?|gets?|getting|seeing|have|has|can['’]?t|cannot)\b`,
      String.raw`\b${CC_ACT}\b${SENT}{0,50}\b${CC_OBJ}\b${SENT}{0,100}\b(?:continues?|persists?|stays?|remains?|(?:it|that|everything) is (?:still )?the same|the same|same (?:error|result|thing|problem)|unchanged)\b`,
      String.raw`\b${CC_ACT}\b${SENT}{0,50}\b${CC_OBJ}\b${SENT}{0,100}\b(?:nothing (?:changes?|changed|happens?|worked)|no (?:change|difference|effect|luck)|(?:did ?n['’]?t|did not) (?:help|change|fix|work)|did nothing|not (?:fixed|helped))\b`,
      String.raw`\b(?:cache|clearing|re-?install(?:ing|ation)?|reset(?:ting)?|clean install)\b${gap(25)}\b(?:did ?n['’]?t|did not|does ?n['’]?t|does not|made no|had no|has no)\b${gap(10)}\b(?:do anything|help|change|fix|work|difference|effect)\b`,
      String.raw`\b(?:tried|did) (?:everything|all|it all)\b${gap(60)}\b(?:cache|re-?install\w*|profile)\b[^\n]{0,40}?\bno (?:luck|change|difference|effect)\b`,
    ].map((pattern) => rx(pattern, { roles: [...CUSTOMER_ROLES] })),
  ],
  // Clearing, deleting, resetting or reinstalling fixed it: a result stated, or the repair named as what fixed it.
  'sig.cache-clear-resolved': [
    ...[
      String.raw`\b${CC_ACT}\b${gap(50)}\b${CC_OBJ_STRICT}\b${gap(80)}\b(?:fixed|solved|resolved|cured|corrected|worked|works|working|did the trick)\b`,
      String.raw`\b${CC_ACT}\b${gap(50)}\b${CC_OBJ}\b${gap(60)}\b(?:(?:now|then|after(?:wards)?) (?:\w+ )?(?:can|could|is able to) (?:log|sign) ?in|(?:log|sign)(?:s)? in (?:now|fine)|(?:logs|signs) in again)`,
      String.raw`\b${CC_ACT}\b${gap(50)}\b${CC_OBJ}\b${gap(60)}\b(?:(?:ok|okay|fine|good|works?|working)(?: again)? now|works again|(?:problem|issue|error|loop) (?:is |was |has )?(?:gone|solved|fixed|resolved|disappeared))`,
      String.raw`\b(?:the )?(?:re-?install\w*|reset|clean install|cache (?:clear\w*|reset|delet\w*)|clearing the cache|deleting the cache|wiping the cache)\b${gap(25)}\b(?:fixed|solved|resolved|cured|worked|did the trick)\b`,
    ].map((pattern) => rx(pattern)),
  ],
  // The browser's own wording of a name that could not be found.
  'sig.error-name-not-resolved': [
    rx(String.raw`\bserver (?:ip )?address (?:could not|couldn['’]?t) be found\b`, {
      roles: [...CUSTOMER_ROLES],
    }),
  ],
  // The failure concentrates at one place, said the way a customer or an engineer says it: a group at a place that cannot, a
  // limit to a place, "mostly at", every affected user in one office, the other places that are fine. Never "all of our offices".
  'sig.site-correlated': [
    ...[
      String.raw`\b${SITE_GROUP}\b${gap(20)}\b(?:in|at|on|from) ${SITE_NAMED}${SITE_NOUN}\b${gap(60)}\b${SITE_TROUBLE}\b`,
      String.raw`\b(?:staff|people|users|colleagues)\b${gap(20)}\b(?:in|at|on|from) ${SITE_NAMED}${SITE_NOUN}\b${gap(20)}\b(?:are|were) all ${SITE_TROUBLE}\b`,
      String.raw`\b(?:limited|restricted|confined|isolated) to ${SITE_NAME}${SITE_NOUN}\b`,
      String.raw`\b(?:only|just|solely) (?:at|in|on|for) ${SITE_NAME}${SITE_NOUN}\b`,
      String.raw`\b(?:at|in|on) ${SITE_NAME}${SITE_NOUN} only\b`,
      String.raw`\b(?:see|seen|happens?|happening|occurs?|occurring|reported|errors?|failures?|problems?)\b${gap(30)}\b(?:mostly|mainly|primarily|especially|only)\b${gap(25)}\b(?:at|in|on|for) ${SITE_NAME}${SITE_NOUN}\b`,
      String.raw`\b(?:only|just|solely)\b${gap(15)}\b(?:happens?|happening|occurs?|occurring|fails?|failing)\b${gap(10)}\b(?:at|in|on|for) ${SITE_NAME}${SITE_NOUN}\b`,
      String.raw`\b(?:the )?(?:other|others|rest|remaining)\b${gap(25)}\b${SITE_REST}\b${gap(40)}\b${SITE_FINE}\b`,
      String.raw`\b(?:nobody|no ?one|none)\b${gap(15)}\b(?:at|in|from)\b${gap(8)}\b(?:the )?(?:other|another|any other)\b${gap(10)}\b${SITE_NOUN}s?\b`,
      String.raw`\b(?:from|at) (?:my |his |her |their |our )?(?:home|house)\b${gap(30)}\b(?:works?|worked|is fine|ok|okay|no problem|signs? in|fine)\b`,
    ].map((pattern) => rx(pattern, { roles: [...CUSTOMER_ROLES], flags: 'iu' })),
    ...[
      String.raw`(?:^|[.!?;,]\s*|\b(?:and|but|while|so) )(?:The |Our )?[A-Z]\p{L}{2,20}(?: [A-Z]\p{L}{2,20})? ${SITE_NOUN} (?:is|are) (?:down|affected|impacted|broken|failing|hit)\b`,
      String.raw`(?!(?:Teams|Outlook|Word|Excel|OneDrive|SharePoint|Chrome|Edge|Windows|Office|Zoom|Slack|Microsoft)\b)\b[A-Z]\p{L}{2,20} (?:and|or|&) [A-Z]\p{L}{2,20} (?:work|works|are|is) normally\b`,
    ].map((pattern) => rx(pattern, { roles: [...CUSTOMER_ROLES], flags: 'u' })),
    rx(
      String.raw`\ball\b${gap(15)}\b(?:affected|failing|impacted)\b${gap(25)}\b(?:users|people|accounts|devices|clients|machines|laptops|colleagues)\b${gap(40)}\b(?:are|sit|work|come|connect|share|behind|on|in|at|from)\b${gap(40)}\b${SITE_NOUN}\b`,
      { roles: [...CUSTOMER_ROLES, ...ENG_ROLES], flags: 'iu' },
    ),
  ],
};

for (const signal of signals) {
  const extra = [
    ...(WORDING_FAMILIES[signal.id] ?? []),
    ...(WORDING_FAMILIES_SCOPE[signal.id] ?? []),
    ...(WORDING_FAMILIES_SERVER_SIDE[signal.id] ?? []),
  ];
  if (extra.length > 0) signal.detectors.push(...extra);
}

const KQL_CORRELATE = [
  '// Correlate client-reported failing attempts with Microsoft Entra sign-in logs.',
  '// Replace the placeholders; never paste real user identifiers into shared notes.',
  'let failing = datatable(UserPrincipalName:string, FailureTimeUtc:datetime)',
  '[ "{{upn_1}}", datetime({{utc_time_1}}), "{{upn_2}}", datetime({{utc_time_2}}) ];',
  'failing',
  '| join kind=leftouter (',
  '    union SigninLogs, AADNonInteractiveUserSignInLogs',
  '    | where TimeGenerated between (datetime({{window_start_utc}}) .. datetime({{window_end_utc}}))',
  '    | project UserPrincipalName, SignInTime = TimeGenerated, ResultType, ResultDescription, CorrelationId',
  ') on UserPrincipalName',
  '| where isnull(SignInTime) or abs(datetime_diff("second", SignInTime, FailureTimeUtc)) <= 120',
  '| summarize MatchedRecords = countif(isnotnull(SignInTime)) by UserPrincipalName, FailureTimeUtc',
].join('\n');

const PS_DNS = [
  '# Compare name resolution for sign-in hosts against EACH resolver used by the affected site.',
  '$resolvers = @({{resolver_list}})        # e.g. "10.0.0.10","10.0.0.11"',
  '$hosts = "login.microsoftonline.com","aadcdn.msftauth.net"',
  'foreach ($r in $resolvers) { foreach ($h in $hosts) { 1..20 | ForEach-Object {',
  '  $res = Resolve-DnsName -Name $h -Server $r -DnsOnly -ErrorAction SilentlyContinue',
  '  [pscustomobject]@{ Resolver = $r; Host = $h; Success = [bool]$res } } } } |',
  '  Group-Object Resolver, Host | ForEach-Object { "{0}: {1}/{2} succeeded" -f $_.Name, ($_.Group | ? Success).Count, $_.Count }',
].join('\n');

const PS_PROXY = [
  '# Test sign-in hosts through EACH proxy node from an affected site (read-only).',
  '$proxies = @({{proxy_list}})              # e.g. "http://proxy-1:8080","http://proxy-2:8080"',
  '$url = "https://login.microsoftonline.com/common/discovery/instance?api-version=1.1&authorization_endpoint=https://login.microsoftonline.com/common/oauth2/authorize"',
  'foreach ($p in $proxies) { 1..20 | ForEach-Object {',
  '  $sw = [Diagnostics.Stopwatch]::StartNew()',
  '  $ok = $true; try { Invoke-WebRequest -Uri $url -Proxy $p -TimeoutSec 10 -UseBasicParsing | Out-Null } catch { $ok = $false }',
  '  [pscustomobject]@{ Proxy = $p; Success = $ok; Ms = $sw.ElapsedMilliseconds } } } |',
  '  Group-Object Proxy | ForEach-Object { "{0}: {1}/{2} succeeded" -f $_.Name, ($_.Group | ? Success).Count, $_.Count }',
].join('\n');

function outcome(
  id: string,
  label: string,
  emitsSignals: string[],
  simulatedResult: string,
  /** The step did not help: it is the outcome of a step that failed. */
  ineffective = false,
) {
  return ineffective
    ? { id, label, emitsSignals, simulatedResult, ineffective }
    : { id, label, emitsSignals, simulatedResult };
}

const ENG = ['support_engineer', 'escalation_engineer'] as const;

const actions: KnowledgeAction[] = [
  {
    id: 'act.request-minimal-scoping',
    label: 'Ask for minimal scoping data',
    description:
      'Ask the customer for the exact client error text or code, three failing sample users with UTC failure times, and which sites or networks are affected versus unaffected.',
    kind: 'customer_request',
    executor: 'customer_admin',
    valueClass: 'enabling',
    timeMinutes: { min: 45, typical: 90, max: 180 },
    tokenEstimate: 600,
    computeUnits: 0,
    customerEffort: 'low',
    operationalRisk: 0,
    destructive: false,
    requiresApproval: false,
    reliability: 0.9,
    requires: [],
    produces: ['req.error-code', 'req.sample-users', 'req.failure-timestamps', 'req.site-pattern'],
    targets: [H.dns, H.proxy, H.client, H.ca, H.token],
    outcomes: [
      outcome(
        'tag-name-not-resolved',
        'Error tag indicates name resolution failure',
        ['sig.error-name-not-resolved'],
        'Customer supplies the error code caa82ee7 (name not resolved) plus sample users and failure times.',
      ),
      outcome(
        'tag-timeout',
        'Error tag indicates a connection timeout',
        ['sig.error-timeout'],
        'Customer supplies the error code caa82ee2 (timeout) plus sample users and failure times.',
      ),
      outcome(
        'tag-other-or-missing',
        'Error tag is other or not available',
        [],
        'Customer supplies sample users and failure times; the on-screen error is generic or not captured.',
      ),
    ],
    detectors: [
      rx(
        String.raw`(please (send|provide|share)|could you (send|provide|share))[^.\n]{0,160}(error (code|text|tag)|sample (affected )?users|failure time|exact time)`,
        { roles: [...ENG] },
      ),
    ],
    templates: {},
    safetyNotes: 'Read-only request. Keep it to three items so customer effort stays low.',
  },
  {
    id: 'act.check-service-health',
    label: 'Check Microsoft 365 service health',
    description:
      'Review Service health and the Message center for active incidents affecting Teams or Microsoft Entra ID.',
    kind: 'analysis',
    executor: 'engineer',
    valueClass: 'diagnostic',
    timeMinutes: { min: 3, typical: 5, max: 15 },
    tokenEstimate: 300,
    computeUnits: 0,
    customerEffort: 'none',
    operationalRisk: 0,
    destructive: false,
    requiresApproval: false,
    reliability: 0.95,
    requires: [],
    produces: [],
    targets: [H.service],
    outcomes: [
      outcome(
        'no-incident',
        'No active incident',
        ['sig.service-health-clear'],
        'Service health shows no active incident for Teams or Entra ID.',
      ),
      outcome(
        'incident-active',
        'Matching incident is active',
        ['sig.service-health-incident'],
        'Service health lists an active incident that matches the symptoms.',
      ),
    ],
    detectors: [
      rx(String.raw`(checked|reviewed|looked at)[^.\n]{0,40}(service health|message center)`, {
        roles: [...ENG],
      }),
    ],
    templates: {},
  },
  {
    id: 'act.request-recent-changes',
    label: 'Ask about recent identity, network or policy changes',
    description:
      'Ask the customer which identity, network, DNS, proxy or policy changes were made in the 48 hours before onset.',
    kind: 'customer_request',
    executor: 'customer_admin',
    valueClass: 'diagnostic',
    timeMinutes: { min: 30, typical: 60, max: 120 },
    tokenEstimate: 400,
    computeUnits: 0,
    customerEffort: 'low',
    operationalRisk: 0,
    destructive: false,
    requiresApproval: false,
    reliability: 0.7,
    requires: [],
    produces: ['req.change-history'],
    targets: [H.dns, H.proxy, H.ca],
    outcomes: [
      outcome(
        'network-change-reported',
        'A network-side change is reported',
        ['sig.recent-network-change-reported'],
        'Customer reports a DNS, proxy or filtering policy change shortly before onset.',
      ),
      outcome(
        'ca-change-reported',
        'An identity-side change is reported',
        ['sig.recent-ca-change-reported'],
        'Customer reports a recent Conditional Access change.',
      ),
      outcome(
        'no-change-reported',
        'No relevant change is reported',
        [],
        'Customer reports no relevant recent changes.',
      ),
    ],
    detectors: [
      rx(
        String.raw`(what|which|any)[^.\n]{0,60}changes?[^.\n]{0,80}(made|deployed|rolled out|before|around)`,
        { roles: [...ENG] },
      ),
    ],
    templates: {},
  },
  {
    id: 'act.signin-log-correlation',
    label: 'Correlate failing attempts with Entra sign-in logs',
    description:
      'Look up each failing attempt (user + UTC time) in SigninLogs and AADNonInteractiveUserSignInLogs. No matching failure record means the attempt never reached the identity service.',
    kind: 'log_query',
    executor: 'engineer',
    valueClass: 'diagnostic',
    timeMinutes: { min: 10, typical: 25, max: 60 },
    tokenEstimate: 3500,
    computeUnits: 4,
    customerEffort: 'none',
    operationalRisk: 0,
    destructive: false,
    requiresApproval: false,
    reliability: 0.85,
    requires: ['req.sample-users', 'req.failure-timestamps'],
    produces: ['req.server-side-correlation'],
    targets: [H.ca, H.token, H.fed, H.service, H.dns, H.proxy],
    outcomes: [
      outcome(
        'no-failures-found',
        'No matching failure records',
        ['sig.no-server-side-failure-records'],
        'None of the failing attempts has a matching failure record: the requests never reached Microsoft Entra ID.',
      ),
      outcome(
        'failures-found',
        'Matching failure records exist',
        ['sig.server-side-failure-records-present'],
        'The failing attempts have matching failure records with result codes to analyse.',
      ),
    ],
    detectors: [
      rx(String.raw`(SigninLogs|AADNonInteractiveUserSignInLogs|sign-?in logs?)`, {
        roles: [...ENG],
        eventTypes: ['engineer_action', 'query_output', 'case_note'],
      }),
    ],
    templates: { kql: KQL_CORRELATE },
    safetyNotes: 'Read-only query. Do not paste raw user identifiers into shared notes.',
  },
  {
    id: 'act.review-ca-policy-config',
    label: 'Review Conditional Access configuration and recent changes',
    description:
      'Review policy assignments, sign-in frequency settings and the audit log for recent Conditional Access changes.',
    kind: 'analysis',
    executor: 'engineer',
    valueClass: 'diagnostic',
    timeMinutes: { min: 10, typical: 20, max: 45 },
    tokenEstimate: 2000,
    computeUnits: 1,
    customerEffort: 'none',
    operationalRisk: 0,
    destructive: false,
    requiresApproval: false,
    reliability: 0.8,
    requires: [],
    produces: ['req.change-history'],
    targets: [H.ca, H.token],
    outcomes: [
      outcome(
        'config-unchanged',
        'No relevant recent policy change',
        ['sig.ca-config-unchanged'],
        'The policy set is unchanged in the relevant period.',
      ),
      outcome(
        'change-found',
        'A recent policy change exists',
        ['sig.recent-ca-change-reported'],
        'A Conditional Access policy was changed shortly before onset.',
      ),
    ],
    detectors: [
      rx(
        String.raw`(review(ed)?|check(ed)?|look(ed)? at)[^.\n]{0,60}(conditional access|ca polic|sign-in frequency)`,
        { roles: [...ENG] },
      ),
    ],
    templates: {},
  },
  {
    id: 'act.dns-resolver-comparison',
    label: 'Compare name resolution across each DNS resolver',
    description:
      'Run Resolve-DnsName for the sign-in and CDN hosts against every DNS resolver used by the affected site and compare the answers.',
    kind: 'network_diagnostic',
    executor: 'customer_network_admin',
    valueClass: 'diagnostic',
    timeMinutes: { min: 30, typical: 75, max: 150 },
    tokenEstimate: 900,
    computeUnits: 1,
    customerEffort: 'low',
    operationalRisk: 0.02,
    destructive: false,
    requiresApproval: false,
    reliability: 0.8,
    requires: ['req.site-pattern'],
    produces: ['req.network-path-check'],
    targets: [H.dns],
    outcomes: [
      outcome(
        'resolvers-inconsistent',
        'A resolver fails while others answer',
        ['sig.resolver-inconsistent'],
        'One resolver returns SERVFAIL or blocks the sign-in host while the other resolvers answer normally.',
      ),
      outcome(
        'resolvers-consistent',
        'All resolvers answer normally',
        ['sig.resolvers-consistent'],
        'Every resolver answers the sign-in hosts normally.',
      ),
    ],
    detectors: [
      rx(String.raw`(?:Resolve-DnsName|nslookup)[^.\n]{0,140}(?:dns server|resolver)`, {
        roles: [...ENG],
      }),
    ],
    templates: { powershell: PS_DNS },
    safetyNotes: 'Read-only DNS queries from an affected site.',
  },
  {
    id: 'act.proxy-node-comparison',
    label: 'Compare sign-in connectivity through each proxy node',
    description:
      'Test the sign-in endpoints through every proxy or TLS-inspection node from an affected site and compare timings.',
    kind: 'network_diagnostic',
    executor: 'customer_network_admin',
    valueClass: 'diagnostic',
    timeMinutes: { min: 45, typical: 90, max: 180 },
    tokenEstimate: 900,
    computeUnits: 1,
    customerEffort: 'medium',
    operationalRisk: 0.02,
    destructive: false,
    requiresApproval: false,
    reliability: 0.75,
    requires: ['req.site-pattern'],
    produces: ['req.network-path-check'],
    targets: [H.proxy],
    outcomes: [
      outcome(
        'nodes-inconsistent',
        'A proxy node times out while others respond',
        ['sig.proxy-node-inconsistent'],
        'One proxy node times out for a share of requests while the others respond quickly.',
      ),
      outcome(
        'nodes-consistent',
        'All proxy nodes respond normally',
        ['sig.proxy-nodes-consistent'],
        'Every proxy node responds normally.',
      ),
    ],
    detectors: [
      rx(
        String.raw`(test|run|check)[^.\n]{0,80}(through|via)[^.\n]{0,40}(each|every|all)[^.\n]{0,40}proxy`,
        {
          roles: [...ENG],
        },
      ),
    ],
    templates: { powershell: PS_PROXY },
    safetyNotes: 'Read-only requests to Microsoft discovery endpoints.',
  },
  {
    id: 'act.device-registration-check',
    label: 'Check device registration and PRT health (dsregcmd)',
    description:
      'Run dsregcmd /status on sampled affected devices and inspect AzureAdPrt and join state.',
    kind: 'client_diagnostic',
    executor: 'customer_end_user',
    valueClass: 'diagnostic',
    timeMinutes: { min: 30, typical: 60, max: 180 },
    tokenEstimate: 500,
    computeUnits: 0,
    customerEffort: 'medium',
    operationalRisk: 0.01,
    destructive: false,
    requiresApproval: false,
    reliability: 0.8,
    requires: [],
    produces: ['req.client-diagnostics'],
    targets: [H.device, H.client, H.token],
    outcomes: [
      outcome(
        'prt-healthy',
        'PRT present on sampled devices',
        ['sig.prt-healthy'],
        'AzureAdPrt: YES on the sampled devices.',
      ),
      outcome(
        'prt-missing',
        'PRT missing on sampled devices',
        ['sig.prt-missing'],
        'AzureAdPrt: NO on the sampled devices.',
      ),
    ],
    detectors: [rx(String.raw`\bdsregcmd\b`, { roles: [...ENG] })],
    templates: {
      powershell: 'dsregcmd /status | Select-String "AzureAdJoined|DomainJoined|AzureAdPrt"',
    },
  },
  {
    id: 'act.check-federation-health',
    label: 'Review federation server health, certificates and clocks',
    description:
      'Check AD FS / STS node health, token-signing certificate validity and clock synchronisation.',
    kind: 'log_query',
    executor: 'customer_admin',
    valueClass: 'diagnostic',
    timeMinutes: { min: 45, typical: 90, max: 180 },
    tokenEstimate: 800,
    computeUnits: 1,
    customerEffort: 'medium',
    operationalRisk: 0.02,
    destructive: false,
    requiresApproval: false,
    reliability: 0.7,
    requires: [],
    produces: [],
    targets: [H.fed],
    outcomes: [
      outcome(
        'federation-errors',
        'Federation errors found',
        ['sig.federation-node-error'],
        'A federation node reports certificate or clock errors.',
      ),
      outcome(
        'federation-healthy',
        'No federation errors found',
        [],
        'Certificates are valid, clocks are in sync and every node reports healthy.',
      ),
    ],
    detectors: [
      rx(String.raw`(ad ?fs|federation)[^.\n]{0,60}(health|certificate|clock)`, {
        roles: [...ENG],
      }),
    ],
    templates: {},
  },
  {
    id: 'act.request-har-capture',
    label: 'Request HAR / Fiddler traces from end users',
    description:
      'Ask users to capture a network trace while a sign-in fails, then analyse the large capture.',
    kind: 'customer_request',
    executor: 'customer_end_user',
    valueClass: 'diagnostic',
    timeMinutes: { min: 120, typical: 240, max: 480 },
    tokenEstimate: 6000,
    computeUnits: 2,
    customerEffort: 'high',
    operationalRisk: 0.02,
    destructive: false,
    requiresApproval: false,
    reliability: 0.5,
    requires: [],
    produces: ['req.client-diagnostics'],
    targets: [H.client, H.dns, H.proxy],
    outcomes: [
      outcome(
        'trace-name-failure',
        'Trace shows name-resolution failures',
        ['sig.error-name-not-resolved'],
        'The trace shows ERR_NAME_NOT_RESOLVED for sign-in hosts.',
      ),
      outcome(
        'trace-timeout',
        'Trace shows timeouts',
        ['sig.error-timeout'],
        'The trace shows connection timeouts.',
      ),
      outcome(
        'trace-inconclusive',
        'Trace is inconclusive',
        [],
        'The capture was taken at the wrong moment or is too large to interpret.',
      ),
    ],
    detectors: [rx(String.raw`\b(HAR|Fiddler)\b[^.\n]{0,80}(capture|trace)`, { roles: [...ENG] })],
    templates: {},
    safetyNotes: 'High customer effort; users are often in calls. Prefer targeted tests first.',
  },
  {
    id: 'act.clear-teams-cache',
    label: 'Clear the Teams client cache on a device',
    description: 'Ask the customer to clear the Teams cache on an affected device and retry.',
    kind: 'client_diagnostic',
    executor: 'customer_end_user',
    valueClass: 'diagnostic',
    timeMinutes: { min: 20, typical: 45, max: 120 },
    tokenEstimate: 500,
    computeUnits: 0,
    customerEffort: 'medium',
    operationalRisk: 0.08,
    destructive: false,
    requiresApproval: false,
    reliability: 0.85,
    requires: [],
    produces: [],
    targets: [H.client],
    outcomes: [
      outcome(
        'still-fails',
        'Still fails after clearing the cache',
        ['sig.cache-clear-no-effect'],
        'The device still fails after the cache was cleared.',
        true,
      ),
      outcome(
        'fixed',
        'Works after clearing the cache',
        ['sig.cache-clear-resolved'],
        'The device signs in after the cache was cleared.',
      ),
    ],
    detectors: [
      rx(String.raw`(clear|delete|reset)[^.\n]{0,40}(teams )?cache`, { roles: [...ENG] }),
    ],
    templates: {},
  },
  {
    id: 'act.reinstall-teams',
    label: 'Reinstall Teams on affected devices',
    description: 'Ask the customer to uninstall and reinstall the Teams client.',
    kind: 'remediation',
    executor: 'customer_end_user',
    valueClass: 'remediation',
    timeMinutes: { min: 60, typical: 120, max: 240 },
    tokenEstimate: 400,
    computeUnits: 0,
    customerEffort: 'high',
    operationalRisk: 0.2,
    destructive: false,
    requiresApproval: false,
    reliability: 0.8,
    requires: [],
    produces: [],
    targets: [H.client],
    outcomes: [
      outcome(
        'still-fails',
        'Still fails after reinstall',
        ['sig.cache-clear-no-effect'],
        'The device still fails after reinstalling.',
        true,
      ),
      outcome(
        'fixed',
        'Works after reinstall',
        ['sig.cache-clear-resolved'],
        'The device signs in after reinstalling.',
      ),
    ],
    detectors: [rx(String.raw`reinstall`, { roles: [...ENG] })],
    templates: {},
  },
  {
    id: 'act.revoke-user-sessions',
    label: 'Revoke refresh tokens and sessions for affected users',
    description: 'Revoke sign-in sessions so every affected user must authenticate again.',
    kind: 'remediation',
    executor: 'customer_admin',
    valueClass: 'remediation',
    timeMinutes: { min: 10, typical: 20, max: 60 },
    tokenEstimate: 300,
    computeUnits: 0,
    customerEffort: 'low',
    operationalRisk: 0.6,
    destructive: true,
    requiresApproval: true,
    reliability: 0.9,
    requires: [],
    produces: [],
    targets: [H.token],
    outcomes: [
      outcome(
        'no-change',
        'No change after revocation',
        ['sig.revoke-sessions-no-effect'],
        'Failures continue after sessions were revoked.',
        true,
      ),
    ],
    detectors: [rx(String.raw`revok(e|ing)[^.\n]{0,40}(sessions?|tokens?)`, { roles: [...ENG] })],
    templates: {},
    safetyNotes:
      'Disruptive: forces every affected user to re-authenticate, multiplying failed attempts during a network fault. Requires approval and a hypothesis that targets tokens.',
  },
  {
    id: 'act.exclude-users-from-mfa-ca',
    label: 'Temporarily exclude users from the MFA policy',
    description: 'Exclude affected users from the MFA Conditional Access policy as a test.',
    kind: 'configuration_change',
    executor: 'customer_admin',
    valueClass: 'remediation',
    timeMinutes: { min: 15, typical: 30, max: 90 },
    tokenEstimate: 400,
    computeUnits: 0,
    customerEffort: 'medium',
    operationalRisk: 0.8,
    destructive: false,
    requiresApproval: true,
    reliability: 0.85,
    requires: [],
    produces: [],
    targets: [H.ca],
    outcomes: [
      outcome(
        'no-change',
        'No change after exclusion',
        ['sig.ca-exclusion-no-effect'],
        'Failures continue after the exclusion.',
        true,
      ),
    ],
    detectors: [
      rx(String.raw`exclude[^.\n]{0,80}(from|for)[^.\n]{0,60}(mfa|conditional access|polic)`, {
        roles: [...ENG],
      }),
    ],
    templates: {},
    safetyNotes:
      'Security-weakening change. Never recommended without confirmed Conditional Access evidence, approval and an expiry.',
  },
  {
    id: 'act.escalate-to-identity-team',
    label: 'Escalate to the identity backend team',
    description: 'Escalate with the evidence collected so far and request backend traces.',
    kind: 'escalation',
    executor: 'engineer',
    valueClass: 'enabling',
    timeMinutes: { min: 240, typical: 480, max: 1440 },
    tokenEstimate: 4000,
    computeUnits: 0,
    customerEffort: 'none',
    operationalRisk: 0.05,
    destructive: false,
    requiresApproval: false,
    reliability: 0.6,
    requires: ['req.server-side-correlation', 'req.sample-users', 'req.failure-timestamps'],
    produces: [],
    targets: [],
    outcomes: [],
    detectors: [
      rx(String.raw`(escalat(e|ing|ion))[^.\n]{0,60}(identity|backend|product group|pg)`, {
        roles: ['support_engineer'],
        eventTypes: ['escalation', 'case_note'],
      }),
    ],
    templates: {},
    safetyNotes:
      'Escalate once the minimum evidence is attached; incomplete escalations are bounced back and cost days.',
  },
  {
    id: 'act.remove-resolver-from-service',
    label: 'Remove the failing DNS resolver from the affected scopes (workaround)',
    description:
      'Temporarily remove the failing resolver from DHCP scopes so clients use healthy resolvers.',
    kind: 'remediation',
    executor: 'customer_network_admin',
    valueClass: 'remediation',
    timeMinutes: { min: 20, typical: 45, max: 120 },
    tokenEstimate: 400,
    computeUnits: 0,
    customerEffort: 'low',
    operationalRisk: 0.2,
    destructive: false,
    requiresApproval: true,
    reliability: 0.9,
    requires: ['req.network-path-check'],
    produces: [],
    targets: [H.dns],
    outcomes: [
      outcome(
        'failures-stop',
        'Failures stop',
        ['sig.dns-fix-resolved'],
        'Failures stop once clients stop using the failing resolver.',
      ),
    ],
    detectors: [
      rx(String.raw`remov(e|ing|ed)[^.\n]{0,40}(resolver|dns server)[^.\n]{0,40}(dhcp|scope)`),
    ],
    templates: {},
    safetyNotes: 'Requires approval; confirm the remaining resolvers can carry the load.',
  },
  {
    id: 'act.restore-dns-policy',
    label: 'Correct the DNS filtering policy (permanent fix)',
    description:
      'Roll back the faulty DNS filtering rule and add an exception for published Microsoft 365 endpoints, under change control.',
    kind: 'configuration_change',
    executor: 'customer_network_admin',
    valueClass: 'remediation',
    timeMinutes: { min: 60, typical: 180, max: 480 },
    tokenEstimate: 600,
    computeUnits: 0,
    customerEffort: 'low',
    operationalRisk: 0.25,
    destructive: false,
    requiresApproval: true,
    reliability: 0.85,
    requires: ['req.network-path-check'],
    produces: [],
    targets: [H.dns],
    outcomes: [
      outcome(
        'failures-stop',
        'Failures stop',
        ['sig.dns-fix-resolved'],
        'Failures stop after the policy is corrected.',
      ),
    ],
    detectors: [
      rx(
        String.raw`(exception|allow-?list|roll(ed)? back)[^.\n]{0,80}(dns|filter|category|microsoft 365)`,
      ),
    ],
    templates: {},
    safetyNotes: 'Permanent change: follow change control.',
  },
  {
    id: 'act.remove-proxy-node-from-rotation',
    label: 'Take the failing proxy node out of rotation (workaround)',
    description: 'Temporarily remove the failing proxy node from the PAC file or load balancer.',
    kind: 'remediation',
    executor: 'customer_network_admin',
    valueClass: 'remediation',
    timeMinutes: { min: 20, typical: 45, max: 120 },
    tokenEstimate: 400,
    computeUnits: 0,
    customerEffort: 'low',
    operationalRisk: 0.2,
    destructive: false,
    requiresApproval: true,
    reliability: 0.9,
    requires: ['req.network-path-check'],
    produces: [],
    targets: [H.proxy],
    outcomes: [
      outcome(
        'failures-stop',
        'Failures stop',
        ['sig.proxy-fix-resolved'],
        'Failures stop once clients stop using the failing proxy node.',
      ),
    ],
    detectors: [
      rx(
        String.raw`(take|remov(e|ing|ed))[^.\n]{0,40}(proxy|node)[^.\n]{0,60}(out of|from)[^.\n]{0,20}(rotation|pac|pool)`,
      ),
    ],
    templates: {},
    safetyNotes: 'Requires approval; confirm remaining nodes have capacity.',
  },
  {
    id: 'act.bypass-proxy-inspection',
    label: 'Bypass TLS inspection for Microsoft 365 endpoints (permanent fix)',
    description:
      'Exempt Microsoft 365 endpoints from TLS inspection per Microsoft published endpoint guidance, under change control.',
    kind: 'configuration_change',
    executor: 'customer_network_admin',
    valueClass: 'remediation',
    timeMinutes: { min: 60, typical: 180, max: 480 },
    tokenEstimate: 600,
    computeUnits: 0,
    customerEffort: 'low',
    operationalRisk: 0.3,
    destructive: false,
    requiresApproval: true,
    reliability: 0.85,
    requires: ['req.network-path-check'],
    produces: [],
    targets: [H.proxy],
    outcomes: [
      outcome(
        'failures-stop',
        'Failures stop',
        ['sig.proxy-fix-resolved'],
        'Failures stop after inspection is bypassed for the endpoints.',
      ),
    ],
    detectors: [rx(String.raw`bypass[^.\n]{0,60}(tls|ssl)? ?inspection`)],
    templates: {},
    safetyNotes:
      'Permanent security-relevant change: follow change control and Microsoft endpoint guidance.',
  },
  {
    id: 'act.validate-fix',
    label: 'Validate the fix with a before/after comparison',
    description:
      'Compare failure rates over a monitoring window, re-run the discriminating test, and get customer confirmation.',
    kind: 'validation',
    executor: 'engineer',
    valueClass: 'validation',
    timeMinutes: { min: 120, typical: 240, max: 1440 },
    tokenEstimate: 2200,
    computeUnits: 2,
    customerEffort: 'low',
    operationalRisk: 0,
    destructive: false,
    requiresApproval: false,
    reliability: 0.9,
    requires: [],
    produces: ['req.fix-validation', 'req.customer-confirmation'],
    targets: [],
    outcomes: [],
    detectors: [
      rx(
        String.raw`(validat(e|ed|ion)|verified)[^.\n]{0,100}(failures?|resolvers?|proxy|sign-?ins?)`,
        {
          roles: ['support_engineer'],
          eventTypes: ['validation_result', 'case_note'],
        },
      ),
    ],
    templates: {},
  },
  {
    id: 'act.communicate-status',
    label: 'Send the customer a status update with next steps and timing',
    description:
      'Tell the customer what was found, what happens next and when they will hear back.',
    kind: 'communication',
    executor: 'engineer',
    valueClass: 'communication',
    timeMinutes: { min: 5, typical: 10, max: 20 },
    tokenEstimate: 700,
    computeUnits: 0,
    customerEffort: 'none',
    operationalRisk: 0,
    destructive: false,
    requiresApproval: false,
    reliability: 1,
    requires: [],
    produces: [],
    targets: [],
    outcomes: [],
    detectors: [],
    templates: {},
  },
];

const requirements: KnowledgeRequirement[] = [
  {
    id: 'req.affected-scope',
    label: 'Scope of impact (who, how many, where)',
    description: 'How many users are affected and whether it is one user, one site, or many.',
    category: 'scoping',
    criticality: 'critical',
    neededFrom: 'case_open',
    askText: 'How many users are affected, and at which sites or networks?',
    satisfiedBySignals: ['sig.multiple-users-affected', 'sig.single-user-scope'],
    satisfiedByDetectors: [],
  },
  {
    id: 'req.business-impact',
    label: 'Business impact confirmed',
    description: 'What the failure prevents the customer from doing and how urgent it is.',
    category: 'scoping',
    criticality: 'important',
    neededFrom: 'case_open',
    askText: 'What is the business impact, and which teams or processes are blocked?',
    satisfiedBySignals: [],
    satisfiedByDetectors: [
      rx(
        String.raw`\b(customer[- ]facing|support queue|shipments?|revenue|dispatch|helpdesk|cannot (join|take|make)|unable to (join|work|serve))\b`,
        { roles: [...CUSTOMER_ROLES] },
      ),
    ],
  },
  {
    id: 'req.error-code',
    label: 'Exact client error code or text',
    description: 'The error tag or message shown on a failing client.',
    category: 'evidence',
    criticality: 'critical',
    neededFrom: 'case_open',
    askText: 'What exact error text or code does the client show on a failing attempt?',
    satisfiedBySignals: ['sig.error-name-not-resolved', 'sig.error-timeout'],
    satisfiedByDetectors: [rx(String.raw`\b(caa[0-9a-f]{5}|0x[0-9a-f]{8}|AADSTS\d{4,6})\b`)],
  },
  {
    id: 'req.sample-users',
    label: 'Sample affected users',
    description: 'At least one affected user identifier for log lookups.',
    category: 'scoping',
    criticality: 'critical',
    neededFrom: 'case_open',
    askText: 'Please provide three sample affected users.',
    satisfiedBySignals: [],
    satisfiedByDetectors: [
      // Bounded, with no repeated group: the unbounded form scanned quadratically over a long run of dots or hyphens.
      rx(String.raw`\b[\w.-]{1,64}@[\w-]{1,63}\.[\w.-]{1,200}\b`, { roles: [...CUSTOMER_ROLES] }),
    ],
  },
  {
    id: 'req.failure-timestamps',
    label: 'Exact failure timestamps (UTC)',
    description: 'UTC times of specific failed attempts, precise enough to correlate with logs.',
    category: 'scoping',
    criticality: 'critical',
    neededFrom: 'case_open',
    askText: 'Please give the UTC time of at least two specific failed attempts.',
    satisfiedBySignals: [],
    satisfiedByDetectors: [
      rx(String.raw`\b\d{2}:\d{2}:\d{2}\s*(UTC|Z)\b|\b20\d{2}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}`, {
        roles: [...CUSTOMER_ROLES],
      }),
    ],
  },
  {
    id: 'req.site-pattern',
    label: 'Affected versus unaffected sites or networks',
    description: 'Which locations, networks or device groups are affected and which are not.',
    category: 'scoping',
    criticality: 'important',
    neededFrom: 'case_open',
    askText: 'Which sites or networks are affected, and which are not?',
    satisfiedBySignals: ['sig.site-correlated'],
    satisfiedByDetectors: [
      rx(String.raw`\b(at|across) (our|the) [A-Z][\w-]+ (site|office|branch)`, {
        roles: [...CUSTOMER_ROLES],
        flags: '',
      }),
    ],
  },
  {
    id: 'req.change-history',
    label: 'Recent environment changes',
    description: 'Network, identity or policy changes shortly before onset.',
    category: 'scoping',
    criticality: 'important',
    neededFrom: 'first_engineer_request',
    askText: 'What network, DNS, proxy or identity changes were made in the 48 hours before onset?',
    satisfiedBySignals: [
      'sig.recent-network-change-reported',
      'sig.recent-ca-change-reported',
      'sig.ca-config-unchanged',
    ],
    satisfiedByDetectors: [],
  },
  {
    id: 'req.server-side-correlation',
    label: 'Server-side sign-in log correlation',
    description: 'Whether failing attempts appear in the identity service logs.',
    category: 'evidence',
    criticality: 'critical',
    neededFrom: 'before_escalation',
    askText: 'Correlate failing attempts (user + UTC time) with Entra sign-in logs.',
    satisfiedBySignals: [
      'sig.no-server-side-failure-records',
      'sig.server-side-failure-records-present',
    ],
    satisfiedByDetectors: [],
  },
  {
    id: 'req.client-diagnostics',
    label: 'Client-side diagnostics from a failing attempt',
    description: 'Client logs, network trace or device registration output from a failing attempt.',
    category: 'evidence',
    criticality: 'important',
    neededFrom: 'before_escalation',
    askText: 'Collect client diagnostics from one failing attempt.',
    satisfiedBySignals: ['sig.prt-healthy', 'sig.prt-missing'],
    satisfiedByDetectors: [
      rx(
        String.raw`\b(HAR|Fiddler|network log|client logs?)\b[^.\n]{0,80}(captured|attached|shows|summary)`,
        {
          roles: [...CUSTOMER_ROLES],
        },
      ),
    ],
  },
  {
    id: 'req.network-path-check',
    label: 'Network path check (DNS or proxy) from an affected site',
    description: 'A per-resolver or per-proxy-node test run from an affected site.',
    category: 'evidence',
    criticality: 'critical',
    neededFrom: 'before_closure',
    askText:
      'Test name resolution per resolver and connectivity per proxy node from an affected site.',
    satisfiedBySignals: [
      'sig.resolver-inconsistent',
      'sig.resolvers-consistent',
      'sig.proxy-node-inconsistent',
      'sig.proxy-nodes-consistent',
    ],
    satisfiedByDetectors: [],
  },
  {
    id: 'req.fix-validation',
    label: 'Fix validated with a before/after comparison',
    description: 'Evidence that failures stopped after the change, over a monitoring window.',
    category: 'closure',
    criticality: 'critical',
    neededFrom: 'before_closure',
    askText: 'Validate with a before/after failure comparison over a monitoring window.',
    satisfiedBySignals: ['sig.dns-fix-resolved', 'sig.proxy-fix-resolved'],
    satisfiedByDetectors: [st('failuresAfterChange', 'eq', 0)],
  },
  {
    id: 'req.customer-confirmation',
    label: 'Customer confirms users can sign in',
    description: 'The customer confirms the problem is resolved for affected users.',
    category: 'closure',
    criticality: 'important',
    neededFrom: 'before_closure',
    askText: 'Ask the customer to confirm users can sign in.',
    satisfiedBySignals: [],
    satisfiedByDetectors: [
      rx(
        String.raw`\b(confirm(ed|s)?|no (further|more) (failures|tickets|reports)|0 (sign-?in )?tickets|users (can|are able to) sign in)\b`,
        { roles: [...CUSTOMER_ROLES] },
      ),
    ],
  },
  {
    id: 'req.workaround-vs-fix',
    label: 'Workaround and permanent fix documented separately',
    description: 'The resolution distinguishes the temporary workaround from the permanent fix.',
    category: 'closure',
    criticality: 'important',
    neededFrom: 'before_closure',
    askText: 'State the workaround and the permanent fix separately.',
    satisfiedBySignals: [],
    satisfiedByDetectors: [
      rx(
        String.raw`workaround[\s\S]{0,400}permanent (fix|solution)|permanent (fix|solution)[\s\S]{0,400}workaround`,
        { roles: [...ENG] },
      ),
    ],
  },
];

export const TEAMS_AUTH_PACK: KnowledgePack = {
  id: 'kp.teams-authentication',
  version: '1.2.0',
  workload: 'teams-authentication',
  title: 'Microsoft Teams authentication failures (illustrative knowledge pack)',
  description:
    'Authored hypotheses, evidence signals, candidate diagnostic actions and minimum-evidence requirements for intermittent Teams desktop sign-in failures.',
  disclaimer:
    'Illustrative knowledge pack authored for the CaseGuard demo. Probabilities, times and effort values are estimates, not Microsoft guidance or measured data.',
  hypotheses,
  signals,
  actions,
  requirements,
  signalPairs: [
    {
      id: 'pair.server-side-records',
      label: 'Server-side records of the failing attempts',
      positive: 'sig.server-side-failure-records-present',
      negative: 'sig.no-server-side-failure-records',
      timeVarying: false,
      denialIsNegative: true,
    },
    {
      id: 'pair.resolvers',
      label: 'Consistency of the name servers',
      positive: 'sig.resolver-inconsistent',
      negative: 'sig.resolvers-consistent',
      timeVarying: true,
      denialIsNegative: true,
    },
    {
      id: 'pair.proxy-nodes',
      label: 'Consistency of the proxy servers',
      positive: 'sig.proxy-node-inconsistent',
      negative: 'sig.proxy-nodes-consistent',
      timeVarying: true,
      denialIsNegative: true,
    },
    {
      id: 'pair.service-health',
      label: 'A Microsoft service incident',
      positive: 'sig.service-health-incident',
      negative: 'sig.service-health-clear',
      timeVarying: true,
      denialIsNegative: true,
    },
    {
      id: 'pair.access-policy-change',
      label: 'A recent change to the access policy',
      positive: 'sig.recent-ca-change-reported',
      negative: 'sig.ca-config-unchanged',
      timeVarying: false,
      denialIsNegative: true,
    },
    {
      id: 'pair.device-token',
      label: 'The primary refresh token of the device',
      positive: 'sig.prt-missing',
      negative: 'sig.prt-healthy',
      timeVarying: true,
      denialIsNegative: true,
    },
    {
      id: 'pair.cache-clear',
      label: 'What clearing the Teams cache did',
      positive: 'sig.cache-clear-no-effect',
      negative: 'sig.cache-clear-resolved',
      timeVarying: false,
      denialIsNegative: false,
    },
    {
      id: 'pair.scope',
      label: 'How many users are affected',
      positive: 'sig.single-user-scope',
      negative: 'sig.multiple-users-affected',
      timeVarying: true,
      denialIsNegative: false,
    },
  ],
  claimPatterns: [
    {
      id: 'clm.affected-user-count',
      subject: 'affected_user_count',
      pattern: String.raw`\b(\d{2,4})\s{1,3}(?:of our\s{1,3})?(?:users|people|employees)\b`,
      flags: 'i',
      valueGroup: 1,
      roles: [...CUSTOMER_ROLES],
      label: 'Number of affected users',
    },
    {
      id: 'clm.client-error-code',
      subject: 'client_error_code',
      pattern: String.raw`\b(caa[0-9a-f]{5})\b`,
      flags: 'i',
      valueGroup: 1,
      label: 'Client error code',
    },
    {
      id: 'clm.failure-start',
      subject: 'failure_start',
      pattern: String.raw`since (?:about |around )?(\d{1,2}:\d{2})\s*(?:UTC)?`,
      flags: 'i',
      valueGroup: 1,
      roles: [...CUSTOMER_ROLES],
      label: 'Reported start of failures',
    },
    {
      id: 'clm.root-cause-statement',
      subject: 'root_cause',
      pattern: String.raw`root cause(?: is| was|:)\s+([^.\n]{5,200})`,
      flags: 'i',
      valueGroup: 1,
      roles: [...ENG],
      label: 'Root-cause statement',
    },
  ],
  lexicon: {
    hedges: [
      'probably',
      'likely',
      'sounds like',
      'seems',
      'appears to',
      'might',
      'may be',
      'possibly',
      'suspect',
      'i think',
      'i believe',
      'still believe',
      'could be',
      'assum',
      'presumably',
      'looks like',
      'my guess',
      'not sure',
      'hypothes',
    ],
    definitive: [
      'root cause is',
      'root cause was',
      'confirmed',
      'the cause is',
      'the issue is',
      'definitely',
      'caused by',
      'is the cause',
      'conclusively',
    ],
    customerReport: [
      'we see',
      'users report',
      'our users',
      'we noticed',
      'we have',
      'reported by',
      'our team',
    ],
    template: [
      'per checklist',
      'as per standard procedure',
      'standard troubleshooting steps completed',
      'all checks completed',
      'no issues found',
      'followed the runbook',
    ],
    workaround: ['workaround', 'temporary fix', 'temporarily', 'interim'],
    permanentFix: [
      'permanent fix',
      'permanent solution',
      'long-term fix',
      'exception for',
      'change control',
    ],
    validation: [
      'validated',
      'validation',
      'verified',
      'monitoring',
      'comparison',
      'consecutive',
      'no failures',
      '0 failures',
    ],
    nextSteps: [
      'next step',
      'next steps',
      'i will',
      'we will',
      'please',
      'plan:',
      'will check',
      'i am going to',
    ],
    expectation: [
      'within',
      'expected',
      'eta',
      'by end of day',
      'in two hours',
      'will update you',
      'check back',
      'update you by',
    ],
    closure: [
      'resolved',
      'marking',
      'close the case',
      'closing',
      'confirmed with the customer',
      'status changed to resolved',
    ],
    injection: [],
  },
  policies: {
    diagnosisThreshold: 0.75,
    minimumEvidenceForEscalation: [
      'req.error-code',
      'req.sample-users',
      'req.failure-timestamps',
      'req.server-side-correlation',
    ],
    destructiveHypothesisThreshold: 0.6,
    lowValueRelativeScore: 0.35,
    lowValueInformationGainBits: 0.08,
    repeatWindowMinutes: 2880,
    customerResponsePriorMinutes: { min: 45, typical: 90, max: 180 },
    maxCounterfactualSteps: 8,
    rolloutCount: 200,
    posteriorFloor: 0.01,
    strengthWeights: { strong: 1, moderate: 0.75, weak: 0.5 },
    forkMinimumImpact: 0.25,
    validationRequirementId: 'req.fix-validation',
    escalationActionIds: ['act.escalate-to-identity-team'],
  },
  inferences: [
    {
      id: 'inf.pre-authentication',
      signalId: 'sig.no-server-side-failure-records',
      text: 'The failing attempts left no server-side sign-in record, so the failure occurs before authentication (client or network path), not inside the identity service.',
      explanation:
        'CaseGuard inference from the absence of matching sign-in log records for the failing attempts.',
      hypothesisCategories: ['network', 'client'],
    },
  ],
};
