import { CaseBundleSchema, type CaseBundle, type EventType } from '@caseguard/schemas';
import { SPLIT_LETTER, WORKLOAD_WITH_PACK, type EvalCase, type EvalWho } from './schema';

/** Event types that carry tool or diagnostic output rather than a message. */
export const TOOL_EVENT_TYPES: ReadonlySet<EventType> = new Set([
  'engineer_action',
  'diagnostic_result',
  'validation_result',
]);

const PARTICIPANTS: Record<
  EvalWho,
  { id: string; role: CaseBundle['participants'][number]['role']; alias: string }
> = {
  customer: { id: 'p-admin', role: 'customer_admin', alias: 'Customer IT Admin' },
  network: { id: 'p-net', role: 'customer_network_admin', alias: 'Customer Network Admin' },
  enduser: { id: 'p-user', role: 'customer_end_user', alias: 'Customer End User' },
  engineer: { id: 'p-eng', role: 'support_engineer', alias: 'Support Engineer' },
  system: { id: 'p-sys', role: 'system', alias: 'System' },
};

/** The roles an event's `who` stands for, as the engine sees them. */
export const ROLE_OF: Readonly<Record<EvalWho, string>> = {
  customer: 'customer_admin',
  network: 'customer_network_admin',
  enduser: 'customer_end_user',
  engineer: 'support_engineer',
  system: 'system',
};

const isoAt = (openedAt: string, minutes: number): string =>
  new Date(Date.parse(openedAt) + minutes * 60_000).toISOString().replace('.000Z', 'Z');

/** `CG-EVAL-D014`: short and unique, because a bundle reference may not be longer than 40 characters. */
export function referenceOf(source: Pick<EvalCase, 'id' | 'split'>): string {
  const number = source.id.split('-')[2] ?? '000';
  return `CG-EVAL-${SPLIT_LETTER[source.split].toUpperCase()}${number}`;
}

/**
 * A valid case bundle for an evaluation case. The events keep the order the case hands them over in (its
 * `handedOverOrder` for a reordered copy), which is not necessarily the order of time.
 */
export function caseToBundle(source: EvalCase): CaseBundle {
  const byKey = new Map(source.events.map((event) => [event.key, event]));
  const ordered = source.handedOverOrder
    ? source.handedOverOrder.map((key) => {
        const event = byKey.get(key);
        if (!event)
          throw new Error(`${source.id}: handedOverOrder names an unknown event "${key}"`);
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
      reference: referenceOf(source),
      title: source.title,
      product: source.workload === WORKLOAD_WITH_PACK ? 'Microsoft Teams' : 'Other product',
      workload: source.workload,
      severity: 'C',
      status: 'open',
      openedAt: source.openedAt,
      customerAlias: 'Evaluation Synthetic Ltd',
      tags: ['synthetic', 'evaluation', ...source.categories],
    },
    participants: (Object.keys(PARTICIPANTS) as EvalWho[])
      .filter((who) => used.has(who))
      .map((who) => ({
        id: PARTICIPANTS[who].id,
        role: PARTICIPANTS[who].role,
        alias: PARTICIPANTS[who].alias,
      })),
    events: ordered.map((event) => ({
      id: event.key,
      timestamp: isoAt(source.openedAt, event.at),
      participantId: PARTICIPANTS[event.who].id,
      type: event.type,
      channel: event.channel,
      ...(event.title ? { title: event.title } : {}),
      body: event.text,
    })),
  });
}
