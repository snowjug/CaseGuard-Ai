import { IdSchema, IsoTimestampSchema } from '@caseguard/schemas';
import { z } from 'zod';
import { systemClock, toIsoTimestamp, type Clock } from '../clock';
import { createIdGenerator } from '../ids';
import { classifyKey } from '../redaction/keys';
import { scrubText } from '../redaction/defaults';

/** Version of the telemetry event shape; bump it when `TelemetryEventSchema` changes incompatibly. */
export const TELEMETRY_SCHEMA_VERSION = 1;

/** Product events the platform may emit. Adding one is a reviewed change, so unknown names are rejected. */
export const TELEMETRY_EVENT_NAMES = [
  'case.created',
  'case.ingested',
  'case.exported',
  'analysis.started',
  'analysis.completed',
  'analysis.failed',
  'counterfactual.started',
  'counterfactual.completed',
  'counterfactual.failed',
  'warning.shown',
  'warning.dismissed',
  'review.submitted',
  'skill.matched',
  'skill.applied',
  'skill.submitted',
  'skill.approved',
  'skill.published',
  'skill.retired',
  'ui.page_viewed',
  'ui.feature_used',
  'ui.error_shown',
  'demo.seeded',
  'demo.reset',
] as const;
/** Name of a documented product event. */
export type TelemetryEventName = (typeof TELEMETRY_EVENT_NAMES)[number];

const MAX_ENTRIES_PER_BAG = 20;

/** Bag keys are snake_case identifiers, so a key can never carry a sentence. */
const BagKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
/** Dimension values are short lower-case tokens (enums such as `succeeded` or `azure-openai`), never free text. */
const DimensionValueSchema = z.string().regex(/^[a-z0-9][a-z0-9_.:-]{0,47}$/);

/**
 * Privacy-safe product telemetry: only ids, counters, durations, flags and enum-like tokens. There is
 * deliberately no field that can hold case text, prompts, names or free-form messages, and every bag
 * entry is checked again for credential-like keys and values that redaction would change.
 */
export const TelemetryEventSchema = z
  .strictObject({
    schemaVersion: z.literal(TELEMETRY_SCHEMA_VERSION),
    eventId: IdSchema,
    name: z.enum(TELEMETRY_EVENT_NAMES),
    occurredAt: IsoTimestampSchema,
    tenantId: IdSchema.optional(),
    caseId: IdSchema.optional(),
    actorId: IdSchema.optional(),
    requestId: IdSchema.optional(),
    /** True when the event came from synthetic demo data. */
    synthetic: z.boolean(),
    counters: z.record(BagKeySchema, z.number().int().min(0).max(1_000_000_000)),
    durationsMs: z.record(BagKeySchema, z.number().min(0).max(86_400_000)),
    flags: z.record(BagKeySchema, z.boolean()),
    dimensions: z.record(BagKeySchema, DimensionValueSchema),
  })
  .superRefine((event, ctx) => {
    const bags = {
      counters: event.counters,
      durationsMs: event.durationsMs,
      flags: event.flags,
      dimensions: event.dimensions,
    };
    for (const [bagName, bag] of Object.entries(bags)) {
      const keys = Object.keys(bag);
      if (keys.length > MAX_ENTRIES_PER_BAG) {
        ctx.addIssue({ code: 'custom', message: 'Too many entries', path: [bagName] });
      }
      for (const key of keys) {
        if (classifyKey(key) !== 'none') {
          ctx.addIssue({
            code: 'custom',
            message: 'Key names a credential or personal field',
            path: [bagName],
          });
        }
      }
    }
    for (const value of Object.values(event.dimensions)) {
      if (scrubText(value) !== value) {
        ctx.addIssue({
          code: 'custom',
          message: 'Value looks like a credential or personal data',
          path: ['dimensions'],
        });
      }
    }
  });
/** A validated product telemetry event. */
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;

/** Input accepted by the telemetry event builder. */
export interface TelemetryEventInput {
  readonly name: TelemetryEventName;
  readonly tenantId?: string;
  readonly caseId?: string;
  readonly actorId?: string;
  readonly requestId?: string;
  readonly synthetic?: boolean;
  readonly counters?: Readonly<Record<string, number>>;
  readonly durationsMs?: Readonly<Record<string, number>>;
  readonly flags?: Readonly<Record<string, boolean>>;
  readonly dimensions?: Readonly<Record<string, string>>;
}

/** Result of building an event: the event, or sanitised validation issues. */
export type TelemetryBuildResult =
  | { readonly ok: true; readonly event: TelemetryEvent }
  | { readonly ok: false; readonly issues: readonly string[] };

/** Options for `createTelemetryEventBuilder`. */
export interface TelemetryBuilderOptions {
  readonly clock?: Clock;
  /** Event id source; defaults to `evt_<ULID>`. */
  readonly generateId?: () => string;
}

const MAX_ISSUE_PATH_LENGTH = 80;
const ALLOWED_INPUT_KEYS: ReadonlySet<string> = new Set([
  'name',
  'tenantId',
  'caseId',
  'actorId',
  'requestId',
  'synthetic',
  'counters',
  'durationsMs',
  'flags',
  'dimensions',
]);

/**
 * Returns a builder that validates input with Zod and returns a result instead of throwing, so a bad
 * event can be counted and dropped on a hot path. Fields the schema does not define are rejected
 * rather than ignored (someone tried to attach content), and issue messages never contain the
 * offending value or key.
 */
export function createTelemetryEventBuilder(
  options: TelemetryBuilderOptions = {},
): (input: TelemetryEventInput) => TelemetryBuildResult {
  const clock = options.clock ?? systemClock;
  const generateId = options.generateId ?? createIdGenerator('evt');
  return (input) => {
    if (Object.keys(input).some((key) => !ALLOWED_INPUT_KEYS.has(key))) {
      return { ok: false, issues: ['(root): Unrecognised keys'] };
    }
    const parsed = TelemetryEventSchema.safeParse({
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      eventId: generateId(),
      name: input.name,
      occurredAt: toIsoTimestamp(clock()),
      tenantId: input.tenantId,
      caseId: input.caseId,
      actorId: input.actorId,
      requestId: input.requestId,
      synthetic: input.synthetic ?? false,
      counters: input.counters ?? {},
      durationsMs: input.durationsMs ?? {},
      flags: input.flags ?? {},
      dimensions: input.dimensions ?? {},
    });
    if (parsed.success) return { ok: true, event: parsed.data };
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => {
        const path = scrubText(issue.path.map(String).join('.')).slice(0, MAX_ISSUE_PATH_LENGTH);
        const message = issue.code === 'unrecognized_keys' ? 'Unrecognised keys' : issue.message;
        return `${path === '' ? '(root)' : path}: ${message}`;
      }),
    };
  };
}
