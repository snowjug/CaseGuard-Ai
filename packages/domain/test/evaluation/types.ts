import { CaseBundleSchema, type CaseBundle, type EventType } from '@caseguard/schemas';

/**
 * The independent evaluation set (Wave 1).
 *
 * These cases were written after the engine and its knowledge pack, in wording of their own, by someone reading the
 * signal definitions (what each signal means) and not the patterns that detect them. Each event lists every signal
 * that a reader would say it states. The list is exhaustive: a signal the engine reports for an event that is not
 * on its list counts as a false positive, one that is on the list and not reported counts as a miss.
 *
 * Limits that matter, and that the evaluation document repeats: one author wrote the cases and the labels, there is
 * no second annotator, the cases are synthetic, and nothing here says how the engine behaves on real support cases.
 */

/** Signal ids of the Teams authentication pack, named after what they mean. */
export const S = {
  intermittent: 'sig.intermittent-failures',
  manyUsers: 'sig.multiple-users-affected',
  siteCorrelated: 'sig.site-correlated',
  singleUser: 'sig.single-user-scope',
  nameNotResolved: 'sig.error-name-not-resolved',
  timeoutError: 'sig.error-timeout',
  mfaCaEvents: 'sig.mfa-ca-events-in-logs',
  tokenExpiry: 'sig.token-expiry-errors',
  policyOutsideWindow: 'sig.policy-events-outside-failure-window',
  noServerRecords: 'sig.no-server-side-failure-records',
  serverRecords: 'sig.server-side-failure-records-present',
  cacheNoEffect: 'sig.cache-clear-no-effect',
  cacheFixed: 'sig.cache-clear-resolved',
  webAlsoFails: 'sig.web-client-also-fails',
  prtHealthy: 'sig.prt-healthy',
  prtMissing: 'sig.prt-missing',
  caChange: 'sig.recent-ca-change-reported',
  caUnchanged: 'sig.ca-config-unchanged',
  networkChange: 'sig.recent-network-change-reported',
  healthClear: 'sig.service-health-clear',
  healthIncident: 'sig.service-health-incident',
  federationError: 'sig.federation-node-error',
  resolverBad: 'sig.resolver-inconsistent',
  resolversOk: 'sig.resolvers-consistent',
  proxyBad: 'sig.proxy-node-inconsistent',
  proxiesOk: 'sig.proxy-nodes-consistent',
  revokeNoEffect: 'sig.revoke-sessions-no-effect',
  caExclusionNoEffect: 'sig.ca-exclusion-no-effect',
  dnsFixed: 'sig.dns-fix-resolved',
  proxyFixed: 'sig.proxy-fix-resolved',
} as const;
export type SignalId = (typeof S)[keyof typeof S];

/** Hypotheses of the Teams sign-in pack, by meaning. */
export const C = {
  dns: 'hyp.dns-resolution',
  proxy: 'hyp.proxy-egress',
  conditionalAccess: 'hyp.conditional-access',
  tokenSession: 'hyp.token-session',
  device: 'hyp.device-state',
  incident: 'hyp.service-incident',
} as const;
export type CauseId = (typeof C)[keyof typeof C];

export type EvalGroup = 'paraphrase' | 'noisy' | 'negative' | 'reordered';
type Who = 'customer' | 'network' | 'enduser' | 'engineer' | 'system';

/** Event types that carry tool or diagnostic output rather than a message. */
const TOOL_TYPES: ReadonlySet<EventType> = new Set([
  'engineer_action',
  'diagnostic_result',
  'validation_result',
]);

export interface EvalEvent {
  /** Stable name of the event, used by the labels and kept when a case is reordered. */
  readonly key: string;
  /** Minutes after the case was opened. */
  readonly at: number;
  readonly who: Who;
  readonly type: EventType;
  readonly channel?: 'email' | 'phone' | 'portal' | 'internal' | 'tool';
  readonly title?: string;
  readonly text: string;
  /** Every signal this event states, by meaning. Empty when it states none. */
  readonly signals?: readonly SignalId[];
}

export interface EvalCase {
  readonly id: string;
  readonly group: EvalGroup;
  /** What the case is about, in one sentence, independent of the pack. */
  readonly about: string;
  readonly events: readonly EvalEvent[];
  /**
   * Key of the event at which the engineer first took a clearly less informative step than one that was available
   * then. Null when there is no such moment. A single annotator's judgement.
   */
  readonly earliestMissed: string | null;
  /**
   * The hypotheses that a reader of the whole story would accept as its cause (more than one when the story fits
   * two of them). Absent for a case that is not a Teams sign-in failure, where no cause should be named.
   */
  readonly causes?: readonly CauseId[];
  /** For a reordered case: the case it is made from, and the order in which its events are handed over. */
  readonly basedOn?: string;
  readonly order?: readonly string[];
}

const WHO: Record<
  Who,
  { id: string; role: CaseBundle['participants'][number]['role']; alias: string }
> = {
  customer: { id: 'p-admin', role: 'customer_admin', alias: 'Customer IT Admin' },
  network: { id: 'p-net', role: 'customer_network_admin', alias: 'Customer Network Admin' },
  enduser: { id: 'p-user', role: 'customer_end_user', alias: 'Customer End User' },
  engineer: { id: 'p-eng', role: 'support_engineer', alias: 'Support Engineer' },
  system: { id: 'p-sys', role: 'system', alias: 'System' },
};

const OPENED_AT = Date.UTC(2026, 5, 2, 8, 0, 0);
const iso = (minutes: number): string =>
  new Date(OPENED_AT + minutes * 60_000).toISOString().replace('.000Z', 'Z');

/** A valid case bundle for an evaluation case, with the events in the order the case says (or its `order`). */
export function toBundle(source: EvalCase): CaseBundle {
  const byKey = new Map(source.events.map((event) => [event.key, event]));
  const ordered = source.order
    ? source.order.map((key) => {
        const event = byKey.get(key);
        if (!event) throw new Error(`${source.id}: the order names an unknown event "${key}"`);
        return event;
      })
    : source.events;
  const used = new Set(ordered.map((event) => event.who));
  return CaseBundleSchema.parse({
    schemaVersion: 'caseguard.case-bundle/1',
    synthetic: true,
    syntheticNotice:
      'SYNTHETIC EVALUATION CASE. Every organisation, person and incident is fictional.',
    case: {
      reference: `CG-EVAL-${source.id.toUpperCase().replace(/[^A-Z0-9]/g, '-')}`,
      title: `Evaluation case ${source.id}: ${source.about}`.slice(0, 200),
      product: 'Microsoft Teams',
      workload: 'teams-authentication',
      severity: 'C',
      status: 'open',
      openedAt: iso(0),
      customerAlias: 'Evaluation Synthetic Ltd',
      tags: ['synthetic', 'evaluation', source.group],
    },
    participants: (Object.keys(WHO) as Who[])
      .filter((who) => used.has(who))
      .map((who) => ({ id: WHO[who].id, role: WHO[who].role, alias: WHO[who].alias })),
    events: ordered.map((event) => ({
      id: event.key,
      timestamp: iso(event.at),
      participantId: WHO[event.who].id,
      type: event.type,
      channel: event.channel ?? (TOOL_TYPES.has(event.type) ? 'tool' : 'email'),
      ...(event.title ? { title: event.title } : {}),
      body: event.text,
    })),
  });
}
