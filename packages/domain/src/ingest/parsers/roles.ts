import type { ParticipantRole } from '@caseguard/schemas';
import { labelKey } from './text';
import type { RoleBasis } from './types';

export interface SpeakerLabel {
  /** Label as written, trimmed. */
  raw: string;
  /** Name part without qualifier or address. */
  name: string;
  /** Text of a trailing `(...)` or `[...]` group, e.g. "query output". */
  qualifier: string | null;
  /** E-mail address found in the label, lower-cased. */
  address: string | null;
}

const ANGLE_ADDRESS = /<([^<>\s@]{1,64}@[^<>\s@]{1,120})>/;
const BARE_ADDRESS = /([A-Za-z0-9._+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,6})/;
const TRAILING_GROUP = /[([]([^()[\]]{1,60})[)\]]\s*$/;

/** Separates a speaker label into name, qualifier and address so none of them leak into aliases. */
export function splitSpeakerLabel(rawInput: string): SpeakerLabel {
  let work = rawInput.trim().slice(0, 200);
  const raw = work;
  let address: string | null = null;
  const angle = ANGLE_ADDRESS.exec(work);
  if (angle) {
    address = (angle[1] ?? '').toLowerCase();
    work = work.replace(ANGLE_ADDRESS, ' ');
  } else {
    const bare = BARE_ADDRESS.exec(work);
    if (bare) {
      address = (bare[1] ?? '').toLowerCase();
      work = work.replace(BARE_ADDRESS, ' ');
    }
  }
  work = work.replace(/\s+/g, ' ').trim();
  let qualifier: string | null = null;
  const group = TRAILING_GROUP.exec(work);
  if (group) {
    qualifier = (group[1] ?? '').trim() || null;
    work = work.slice(0, group.index).trim();
  }
  return { raw, name: work, qualifier, address };
}

export interface RoleInference {
  role: ParticipantRole;
  basis: RoleBasis;
  /** The label contained signals from both sides; the chosen reading is a judgement call. */
  ambiguous: boolean;
}

const SYSTEM_STRONG = new Set([
  'bot',
  'automation',
  'automated',
  'robot',
  'noreply',
  'daemon',
  'scheduler',
  'monitor',
  'monitoring',
  'workflow',
  'pipeline',
]);
const ESCALATION = new Set(['escalation', 'escalations', 'sme', 'tier3', 'l3', 'pg']);
const MANAGER = new Set(['manager', 'mgr', 'supervisor', 'director', 'lead']);
const NETWORK = new Set(['network', 'networking', 'netadmin', 'netops']);
const NETWORK_NEEDS_ADMIN = new Set(['proxy', 'firewall', 'dns']);
const ENGINEER_STRONG = new Set([
  'support',
  'agent',
  'tse',
  'csa',
  'cse',
  'specialist',
  'technician',
  'owner',
  'dri',
  'tam',
]);
const ENGINEER_WEAK = new Set(['engineer', 'engineers', 'eng', 'analyst']);
const ADMIN = new Set([
  'admin',
  'admins',
  'administrator',
  'it',
  'helpdesk',
  'sysadmin',
  'itadmin',
]);
const END_USER = new Set(['user', 'users', 'employee', 'staff', 'enduser']);
const CUSTOMER = new Set([
  'customer',
  'customers',
  'client',
  'cust',
  'cx',
  'requester',
  'requestor',
  'caller',
  'reporter',
  'contact',
  'tenant',
  'contoso',
  'fabrikam',
]);

function tokensOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.replace(/\d+$/, '') || t)
    .filter((t) => t.length > 0)
    .slice(0, 24);
}

/**
 * Infers a participant role from the words of a speaker label. It never uses the person's
 * name: only role words count, so "Escalation Engineer" and "Contoso admin" resolve, while
 * "Anna Schmidt" stays unknown instead of being guessed.
 */
export function inferRole(
  label: SpeakerLabel,
  overrides?: Readonly<Record<string, ParticipantRole>>,
): RoleInference {
  if (overrides) {
    const hit = lookupOverride(overrides, label);
    if (hit) return { role: hit, basis: 'override', ambiguous: false };
  }
  const tokens = tokensOf(`${label.name} ${label.qualifier ?? ''}`);
  const has = (set: ReadonlySet<string>) => tokens.some((t) => set.has(t));
  const joined = tokens.join(' ');
  const admin = has(ADMIN);
  const customer = has(CUSTOMER);
  const strongEngineer = has(ENGINEER_STRONG);
  const weakEngineer = has(ENGINEER_WEAK);
  const hasPhrase = (phrase: string) => ` ${joined} `.includes(` ${phrase} `);

  if (has(SYSTEM_STRONG)) return found('system', 'keyword', false);
  if (tokens.includes('system') && !admin && !customer && !strongEngineer && !weakEngineer) {
    return found('system', 'keyword', false);
  }
  if (has(ESCALATION) || hasPhrase('tier 3') || hasPhrase('product group')) {
    return found('escalation_engineer', 'keyword', customer);
  }
  if (has(MANAGER)) {
    if (admin || customer) return found('customer_admin', 'keyword', true);
    return found('support_manager', 'keyword', false);
  }
  const network = has(NETWORK) || (has(NETWORK_NEEDS_ADMIN) && (admin || weakEngineer));
  if (network && !strongEngineer) {
    return found('customer_network_admin', 'keyword', weakEngineer && !admin);
  }
  if (strongEngineer) return found('support_engineer', 'keyword', customer && !admin);
  if (weakEngineer) {
    if (admin) return found('customer_admin', 'keyword', true);
    return found('support_engineer', 'keyword', customer);
  }
  if (admin) return found('customer_admin', 'keyword', false);
  if (has(END_USER) || hasPhrase('end user')) return found('customer_end_user', 'keyword', false);
  if (customer) return found('customer_admin', 'generic_customer', false);
  return { role: 'system', basis: 'unknown', ambiguous: false };
}

function found(role: ParticipantRole, basis: RoleBasis, ambiguous: boolean): RoleInference {
  return { role, basis, ambiguous };
}

function lookupOverride(
  overrides: Readonly<Record<string, ParticipantRole>>,
  label: SpeakerLabel,
): ParticipantRole | undefined {
  const wanted = new Set([labelKey(label.raw), labelKey(label.name)]);
  for (const [key, role] of Object.entries(overrides)) {
    if (wanted.has(labelKey(key))) return role;
  }
  return undefined;
}

/** Pseudonymous alias per role, matching the style of the synthetic sample bundles. */
export function aliasFor(role: ParticipantRole, ordinal: number, unidentified: boolean): string {
  if (unidentified) return `Unidentified Participant ${ordinal}`;
  switch (role) {
    case 'customer_admin':
      return `Customer IT Admin ${ordinal}`;
    case 'customer_end_user':
      return `Customer End User ${ordinal}`;
    case 'customer_network_admin':
      return `Customer Network Admin ${ordinal}`;
    case 'support_engineer':
      return `Support Engineer ${ordinal}`;
    case 'escalation_engineer':
      return `Escalation Engineer ${ordinal}`;
    case 'support_manager':
      return `Support Manager ${ordinal}`;
    case 'system':
      return ordinal === 1 ? 'Case System' : `Case System ${ordinal}`;
  }
}

const ID_STEM: Record<ParticipantRole, string> = {
  customer_admin: 'p-cust-admin',
  customer_end_user: 'p-cust-user',
  customer_network_admin: 'p-cust-net',
  support_engineer: 'p-eng',
  escalation_engineer: 'p-esc',
  support_manager: 'p-mgr',
  system: 'p-system',
};

/** Default participant ids (`p-eng`, `p-eng-2`, ...), matching the sample bundles. */
export function defaultParticipantId(
  role: ParticipantRole,
  ordinal: number,
  unidentified: boolean,
): string {
  const stem = unidentified ? 'p-unidentified' : ID_STEM[role];
  return ordinal === 1 ? stem : `${stem}-${ordinal}`;
}

/** Key identifying one real-world speaker: the address when known, else the normalised name. */
export function speakerKeyOf(label: SpeakerLabel): string {
  return label.address ?? (labelKey(label.name) || labelKey(label.raw) || 'unnamed');
}

const BLOCKED_LABELS = new Set([
  'error',
  'warning',
  'warn',
  'info',
  'debug',
  'trace',
  'fatal',
  'note',
  'notes',
  'result',
  'results',
  'output',
  'update',
  'status',
  'summary',
  'action',
  'actions',
  'step',
  'steps',
  'example',
  'http',
  'https',
  'ftp',
  'file',
  'subject',
  'from',
  'to',
  'cc',
  'bcc',
  'sent',
  'date',
  're',
  'fwd',
  'root cause',
  'workaround',
  'permanent fix',
  'validation',
  'resolution',
  'cause',
  'fix',
  'issue',
  'problem',
  'solution',
  'impact',
  'scope',
  'next steps',
  'regards',
  'thanks',
  'thank you',
  'hello',
  'hi',
  'dear',
  'attachment',
  'attachments',
  'command',
  'query',
  'exception',
  'stack trace',
]);

/** Shape test for text before a delimiter: short, word-like, and not a well-known field name. */
export function isPlausibleLabel(label: SpeakerLabel): boolean {
  const name = label.name;
  if (name.length === 0 || name.length > 60) return false;
  const words = name.split(' ');
  if (words.length > 6) return false;
  if (!/^[\p{L}\p{N}]/u.test(name)) return false;
  if (/^\d+$/.test(name)) return false;
  if (/[?!;,|]/.test(name)) return false;
  if (/\.\s|\.$/.test(name)) return false;
  if (/[\\/]/.test(name)) return false;
  if (/[()[\]{}<>=]/.test(name)) return false;
  return !BLOCKED_LABELS.has(labelKey(name));
}
