import {
  CaseStatusSchema,
  ParticipantRoleSchema,
  SeveritySchema,
  type CaseStatus,
  type ParticipantRole,
  type Severity,
} from '@caseguard/schemas';
import { IngestParseError } from './errors';
import { resolveLimits, type ParserLimits } from './limits';
import { defaultParticipantId } from './roles';
import { parseCalendarDate, type CalendarDate } from './timestamps';
import type { DateOrder, DraftOptions, IdFactory } from './types';

export const DEFAULT_WORKLOAD = 'teams-authentication';
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export const defaultIdFactory: IdFactory = {
  eventId: (index, total) =>
    `e${String(index + 1).padStart(Math.max(2, String(total).length), '0')}`,
  participantId: defaultParticipantId,
};

/** Options after validation: every field is trusted and typed. */
export interface ResolvedOptions {
  synthetic: boolean;
  syntheticNotice: string | null;
  now: string;
  nowMs: number;
  defaultDate: CalendarDate | null;
  assumedOffsetMinutes: number;
  dateOrder: DateOrder | null;
  limits: ParserLimits;
  ids: IdFactory;
  title: string | null;
  reference: string | null;
  product: string | null;
  workload: string | null;
  severity: Severity | null;
  status: CaseStatus | null;
  customerAlias: string | null;
  tags: string[];
  speakerRoles: Readonly<Record<string, ParticipantRole>> | undefined;
}

function invalid(message: string): never {
  throw new IngestParseError('invalid_options', message);
}

function optionalString(options: object, key: string): string | null {
  const value = (options as Record<string, unknown>)[key];
  if (value === undefined) return null;
  if (typeof value !== 'string') invalid(`Option "${key}" must be a string.`);
  return value;
}

/** Validates the options once; every parser then works with trusted, typed values. */
export function resolveDraftOptions(options: DraftOptions): ResolvedOptions {
  if (typeof options !== 'object' || options === null) invalid('Parser options are required.');
  if (typeof options.synthetic !== 'boolean') {
    invalid('Option "synthetic" must be explicitly true or false.');
  }
  if (typeof options.now !== 'string' || !ISO_UTC.test(options.now)) {
    invalid('Option "now" must be a UTC ISO-8601 timestamp such as 2026-03-09T09:12:00Z.');
  }
  const nowMs = Date.parse(options.now);
  if (!Number.isFinite(nowMs)) invalid('Option "now" is not a valid instant.');

  let defaultDate: CalendarDate | null = null;
  if (options.defaultDate !== undefined) {
    defaultDate = parseCalendarDate(options.defaultDate);
    if (!defaultDate) invalid('Option "defaultDate" must be a real date written as YYYY-MM-DD.');
  }
  const offset = options.assumedUtcOffsetMinutes ?? 0;
  if (!Number.isInteger(offset) || offset < -720 || offset > 840) {
    invalid('Option "assumedUtcOffsetMinutes" must be a whole number between -720 and 840.');
  }
  if (
    options.dateOrder !== undefined &&
    options.dateOrder !== 'dmy' &&
    options.dateOrder !== 'mdy'
  ) {
    invalid('Option "dateOrder" must be "dmy" or "mdy".');
  }
  const severity =
    options.severity === undefined ? null : SeveritySchema.safeParse(options.severity);
  if (severity && !severity.success) invalid('Option "severity" must be A, B or C.');
  const status = options.status === undefined ? null : CaseStatusSchema.safeParse(options.status);
  if (status && !status.success) invalid('Option "status" must be open, resolved or closed.');
  for (const [label, role] of Object.entries(options.speakerRoles ?? {})) {
    if (!ParticipantRoleSchema.safeParse(role).success) {
      invalid(`Option "speakerRoles" maps "${label}" to an unknown role.`);
    }
  }
  const tags: string[] = [];
  if (options.tags !== undefined) {
    if (!Array.isArray(options.tags)) invalid('Option "tags" must be an array.');
    for (const tag of options.tags as readonly unknown[]) {
      if (typeof tag !== 'string') invalid('Option "tags" must contain only strings.');
      tags.push(tag);
    }
  }
  const ids = options.ids ?? defaultIdFactory;
  if (typeof ids.eventId !== 'function' || typeof ids.participantId !== 'function') {
    invalid('Option "ids" must provide eventId() and participantId().');
  }

  return {
    synthetic: options.synthetic,
    syntheticNotice: optionalString(options, 'syntheticNotice'),
    now: options.now,
    nowMs,
    defaultDate,
    assumedOffsetMinutes: offset,
    dateOrder: options.dateOrder ?? null,
    limits: resolveLimits(options.limits),
    ids,
    title: optionalString(options, 'title'),
    reference: optionalString(options, 'reference'),
    product: optionalString(options, 'product'),
    workload: optionalString(options, 'workload'),
    severity: severity?.success ? severity.data : null,
    status: status?.success ? status.data : null,
    customerAlias: optionalString(options, 'customerAlias'),
    tags,
    speakerRoles: options.speakerRoles,
  };
}
