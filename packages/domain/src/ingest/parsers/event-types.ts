import {
  CUSTOMER_SIDE_ROLES,
  ENGINEER_SIDE_ROLES,
  EVENT_TYPES,
  EVENT_TYPE_LABELS,
  type EventType,
  type ParticipantRole,
} from '@caseguard/schemas';
import type { TypeBasis } from './types';

export interface TypeInput {
  role: ParticipantRole;
  /** False when the role could not be inferred; the speaker is then kept neutral. */
  roleKnown: boolean;
  /** Trailing `(...)` of the speaker label, e.g. "query output". */
  qualifier: string | null;
  body: string;
  isEmailBlock: boolean;
}

export interface TypeDecision {
  type: EventType;
  basis: TypeBasis;
}

const TYPE_ALIASES = new Map<string, EventType>([
  ['note', 'case_note'],
  ['internal_note', 'case_note'],
  ['case_notes', 'case_note'],
  ['action', 'engineer_action'],
  ['engineer_step', 'engineer_action'],
  ['query', 'query_output'],
  ['query_result', 'query_output'],
  ['log', 'log_sample'],
  ['logs', 'log_sample'],
  ['diagnostic', 'diagnostic_result'],
  ['call', 'customer_call'],
  ['phone_call', 'customer_call'],
  ['customer_reply', 'customer_email'],
  ['customer_message', 'customer_email'],
  ['engineer_reply', 'engineer_email'],
  ['engineer_message', 'engineer_email'],
  ['escalate', 'escalation'],
  ['status', 'status_change'],
  ['resolution', 'resolution_note'],
  ['validation', 'validation_result'],
  ['system', 'system_event'],
]);

const LABEL_TO_TYPE = new Map<string, EventType>(
  EVENT_TYPES.flatMap((t) => [
    [t, t] as const,
    [EVENT_TYPE_LABELS[t].toLowerCase().replace(/[\s-]+/g, '_'), t] as const,
  ]),
);

/** Maps an explicit type name (column cell or label qualifier) to an event type. */
export function eventTypeFromText(value: string): EventType | null {
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z_]/g, '');
  return LABEL_TO_TYPE.get(key) ?? TYPE_ALIASES.get(key) ?? null;
}

const STATUS_PATTERN =
  /^\s*(?:case\s+)?(?:status|severity|priority)\s+(?:changed|updated|set|raised|lowered)\b|^\s*case\s+(?:closed|re-?opened|resolved)\b|^\s*status\s*[:=]\s*\w+/i;
const RESOLUTION_PATTERN =
  /^\s*(?:resolution(?:\s+(?:summary|notes?))?|resolved|root\s+cause(?:\s+analysis)?|rca)\s*[:.\u2013-]/i;
const VALIDATION_PATTERN =
  /^\s*(?:validation|verification)\b|^\s*(?:validated|verified)\s+(?:the\s+)?(?:fix|workaround|resolution|change|solution)\b/i;
const ESCALATION_PATTERN = /^\s*escalat(?:e|es|ed|ing|ion)\b/i;
const CALL_PATTERN =
  /^\s*(?:(?:phone|voice|conference)\s+)?call\s*(?:notes?|summary)?\s*[:\u2013-]|^\s*on\s+(?:the|a)\s+(?:phone\s+)?call\b/i;
const ACTION_VERB_PATTERN =
  /^\s*(?:i\s+)?(?:have\s+|'ve\s+|just\s+)?(?:checked|ran|re-?ran|run|reviewed|collected|tested|queried|analy[sz]ed|correlated|captured|restarted|reset|cleared|disabled|enabled|reproduced|inspected|pulled|exported|performed|compared|searched|revoked|started|excluded|removed|flushed|deleted|rolled|applied|configured)\b/i;
const SALUTATION_PATTERN =
  /^\s*(?:hello|hi|hey|dear|good\s+(?:morning|afternoon|evening))\b[^\n]{0,60}$/im;
const CLOSING_PATTERN =
  /^\s*(?:kind\s+regards|best\s+regards|warm\s+regards|regards|many\s+thanks|thanks|thank\s+you|sincerely|cheers|best)\s*[,.!]?(?:\s+[\p{L}'-]+){0,2}\s*$/iu;

/** True when the text opens with a greeting or ends with a sign-off, as an e-mail would. */
export function looksLikeEmail(body: string): boolean {
  const head = body.slice(0, 200);
  const firstLine = head.split('\n', 1)[0] ?? '';
  if (SALUTATION_PATTERN.test(firstLine)) return true;
  const lines = body.slice(-300).split('\n');
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 4; i--) {
    const line = (lines[i] ?? '').trim();
    if (line.length === 0) continue;
    if (CLOSING_PATTERN.test(line)) return true;
  }
  return false;
}

export interface BlockShape {
  codeLike: boolean;
  kind: 'query' | 'log' | 'other';
}

const QUERY_CUE =
  /\|\s*(?:where|project|summarize|extend|join|take|top|order|distinct|render)\b|\bSELECT\b[\s\S]{0,80}\bFROM\b|^\s*PS\s+\S*>|\b(?:Get|Set|Test|Resolve|Invoke)-[A-Z]\w+|^\s*(?:nslookup|ipconfig|curl|dsregcmd|ping|tracert|netsh)\b/im;
const CODE_LINE_PATTERNS: readonly RegExp[] = [
  /^\s{2,}\S/,
  /^\s*[|{}[\]]/,
  /^\s*(?:\$|#>|>>?)\s/,
  /\|\s*(?:where|project|summarize|extend|join|take|top|order|distinct|render)\b/,
  /\b(?:SELECT|WHERE|GROUP BY|ORDER BY)\b.*\b(?:FROM|BY|=)\b/,
  /^\s*[A-Za-z_][\w.]{0,40}\s*=\s*\S/,
  /\S {2,}\S.* {2,}\S/,
  /\S \| \S/,
  /^\(\d+\s+rows?\b/i,
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/,
  /^\s*\[?(?:ERROR|WARN|WARNING|INFO|DEBUG|TRACE)\]?\b/,
];
const LOG_LINE =
  /^\s*(?:\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}|\[?(?:ERROR|WARN|WARNING|INFO|DEBUG|TRACE)\]?\b)/;
const MAX_SHAPE_LINES = 200;

/** Decides whether a body is mostly code, query text, tool output or log lines. */
export function analyseShape(body: string): BlockShape {
  const trimmed = body.trim();
  const fenced = trimmed.startsWith('```') && trimmed.endsWith('```') && trimmed.length > 6;
  const lines = trimmed
    .split('\n', MAX_SHAPE_LINES)
    .map((l) => l.slice(0, 300))
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { codeLike: false, kind: 'other' };
  const codeLines = lines.filter((l) => CODE_LINE_PATTERNS.some((p) => p.test(l))).length;
  const codeLike = fenced || (lines.length >= 3 && codeLines / lines.length >= 0.6);
  if (!codeLike) return { codeLike: false, kind: 'other' };
  const sample = lines.join('\n');
  if (QUERY_CUE.test(sample)) return { codeLike: true, kind: 'query' };
  const logLines = lines.filter((l) => LOG_LINE.test(l)).length;
  return { codeLike: true, kind: logLines / lines.length >= 0.5 ? 'log' : 'other' };
}

const decision = (type: EventType, basis: TypeBasis): TypeDecision => ({ type, basis });

function codeDecision(shape: BlockShape, customerSide: boolean): TypeDecision {
  if (shape.kind === 'log') return decision('log_sample', 'code_like');
  if (shape.kind === 'query' && !customerSide) return decision('query_output', 'code_like');
  return decision('diagnostic_result', 'code_like');
}

/**
 * Conservative event-type inference. Each rule needs positive evidence; when none applies the
 * neutral type is used (`case_note` for engineers, `customer_email` for the customer side) and
 * the basis says so, so the preview can show which events were not decided by evidence.
 */
export function inferEventType(input: TypeInput): TypeDecision {
  if (input.qualifier) {
    const explicit = eventTypeFromText(input.qualifier);
    if (explicit) return decision(explicit, 'explicit');
  }
  const head = input.body.slice(0, 300);
  if (STATUS_PATTERN.test(head)) return decision('status_change', 'status_pattern');
  if (input.roleKnown && input.role === 'system') return decision('system_event', 'system_role');

  const shape = analyseShape(input.body);
  if (!input.roleKnown) {
    if (shape.codeLike) return codeDecision(shape, false);
    return decision('case_note', 'unknown_speaker');
  }

  const emailLike = input.isEmailBlock || looksLikeEmail(input.body);
  if (CUSTOMER_SIDE_ROLES.includes(input.role)) {
    if (shape.codeLike) return codeDecision(shape, true);
    if (CALL_PATTERN.test(head)) return decision('customer_call', 'call_marker');
    return decision('customer_email', emailLike ? 'email_block' : 'customer_side');
  }

  if (!ENGINEER_SIDE_ROLES.includes(input.role)) return decision('case_note', 'default');
  if (RESOLUTION_PATTERN.test(head)) return decision('resolution_note', 'resolution_pattern');
  if (VALIDATION_PATTERN.test(head)) return decision('validation_result', 'validation_pattern');
  if (input.role === 'escalation_engineer') {
    if (emailLike) return decision('engineer_email', 'email_block');
    return decision('escalation_response', 'escalation_pattern');
  }
  if (ESCALATION_PATTERN.test(head)) return decision('escalation', 'escalation_pattern');
  if (shape.codeLike) return codeDecision(shape, false);
  if (emailLike)
    return decision('engineer_email', input.isEmailBlock ? 'email_block' : 'salutation');
  if (ACTION_VERB_PATTERN.test(head)) return decision('engineer_action', 'action_verb');
  return decision('case_note', 'default');
}
