import {
  type BundleEvent,
  type BundleResolution,
  type CaseBundle,
  type RedactionCategory,
  type RedactionConfig,
  type RedactionSummary,
  type StructuredRecord,
  type ValidationIssue,
} from '@caseguard/schemas';
import {
  SECRET_REDACTION_CATEGORIES,
  assertRedactionComplete,
  createPseudonymState,
  redactTexts,
  redactValues,
  type CustomPatternBudget,
  type RedactionOptions,
} from '@caseguard/security';
import { errorIssue } from './issues';
import type { EventRedaction } from './types';

export interface BundleRedaction {
  readonly bundle: CaseBundle;
  readonly summary: RedactionSummary;
  /** Only events with at least one replacement have an entry. Null-prototype map. */
  readonly byEventId: Record<string, EventRedaction>;
}

/**
 * Credentials are redacted whatever a tenant switched off in governance: settings can narrow the
 * personal-data categories, never the secret ones. Data that is not declared synthetic also loses the
 * exemption for reserved test values (private addresses, example domains): they are real there.
 * `budget` is the request's allowance of custom-pattern time; every redaction call of one request
 * must be given the same one so that they share it.
 */
export function redactionOptionsFor(
  config: RedactionConfig,
  synthetic: boolean,
  budget?: CustomPatternBudget,
): RedactionOptions {
  const enabled = new Set<RedactionCategory>([
    ...config.enabledCategories,
    ...SECRET_REDACTION_CATEGORIES,
  ]);
  return {
    enabledCategories: [...enabled],
    customPatterns: config.customPatterns,
    redactReservedValues: !synthetic,
    ...(budget === undefined ? {} : { customPatternBudget: budget }),
  };
}

/** What the engine redacts: a free-text field, or the structured record of an event. */
type Part = string | StructuredRecord;

/** What a walk over (a part of) a bundle does with each free-text field, in the order it meets them. */
interface Mapper {
  text(value: string): string;
  record(value: StructuredRecord): StructuredRecord;
}

/** First pass of a walk: notes the fields down in order and hands them back as they were. */
class Collecting implements Mapper {
  readonly parts: Part[] = [];

  text(value: string): string {
    this.parts.push(value);
    return value;
  }

  record(value: StructuredRecord): StructuredRecord {
    this.parts.push(value);
    return value;
  }
}

/** Second pass of the same walk: hands out the redacted fields in the order they were collected. */
class Replaying implements Mapper {
  private position = 0;

  constructor(private readonly parts: readonly Part[]) {}

  text(): string {
    const part = this.take();
    if (typeof part !== 'string') throw mismatch();
    return part;
  }

  record(): StructuredRecord {
    const part = this.take();
    if (typeof part === 'string') throw mismatch();
    return part;
  }

  private take(): Part {
    const part = this.parts[this.position];
    this.position += 1;
    if (part === undefined) throw mismatch();
    return part;
  }
}

const mismatch = (): Error => new Error('the redacted fields do not match the fields collected');

/** A piece of the bundle (the case record, one event, the resolution) as a walk over its fields. */
interface Unit<T> {
  /** The fields to redact, in the order the engine must see them. */
  readonly parts: readonly Part[];
  /** Rebuilds the piece from the redacted fields (same order, same count as `parts`). */
  build(redacted: readonly Part[]): T;
}

/**
 * One walk function says which fields a piece has and in what order, once. Running it with a
 * collector gives the fields to redact; running it again with the redacted values writes them back, so
 * the order of collection and of write-back cannot drift apart.
 */
function plan<T>(walk: (mapper: Mapper) => T): Unit<T> {
  const collecting = new Collecting();
  walk(collecting);
  return { parts: collecting.parts, build: (redacted) => walk(new Replaying(redacted)) };
}

/** Case title, product, customer alias, tags, participant aliases and the synthetic notice. */
function walkCase(bundle: CaseBundle, mapper: Mapper) {
  const caseRecord = {
    ...bundle.case,
    title: mapper.text(bundle.case.title),
    product: mapper.text(bundle.case.product),
    customerAlias: mapper.text(bundle.case.customerAlias),
    tags: bundle.case.tags.map((tag) => mapper.text(tag)),
  };
  const participants = bundle.participants.map((participant) => ({
    ...participant,
    alias: mapper.text(participant.alias),
  }));
  const syntheticNotice =
    bundle.syntheticNotice === undefined ? undefined : mapper.text(bundle.syntheticNotice);
  return { caseRecord, participants, syntheticNotice };
}

function walkEvent(event: BundleEvent, mapper: Mapper): BundleEvent {
  return {
    ...event,
    ...(event.title !== undefined ? { title: mapper.text(event.title) } : {}),
    body: mapper.text(event.body),
    ...(event.action !== undefined
      ? { action: { ...event.action, label: mapper.text(event.action.label) } }
      : {}),
    correlationIds: event.correlationIds.map((id) => mapper.text(id)),
    // String values under secret-named keys (`password`, `apiKey`, ...) are replaced outright.
    ...(event.structured !== undefined ? { structured: mapper.record(event.structured) } : {}),
  };
}

function walkResolution(resolution: BundleResolution, mapper: Mapper): BundleResolution {
  return {
    ...resolution,
    summary: mapper.text(resolution.summary),
    rootCause: mapper.text(resolution.rootCause),
    ...(resolution.workaround !== undefined
      ? { workaround: mapper.text(resolution.workaround) }
      : {}),
    ...(resolution.permanentFix !== undefined
      ? { permanentFix: mapper.text(resolution.permanentFix) }
      : {}),
    ...(resolution.validation !== undefined
      ? {
          validation: {
            ...resolution.validation,
            method: mapper.text(resolution.validation.method),
          },
        }
      : {}),
  };
}

/**
 * Redacts every free-text field of a bundle (case title, product, customer alias, tags, participant
 * aliases, event title/body/action label/correlation ids/structured values and the resolution text)
 * before anything is stored or shown. Identifiers (ids, reference, workload, action keys) are left
 * alone because other records point at them; see `credentialLikeIdentifiers` for those.
 *
 * The whole bundle is ONE batch for the engine: a tenant's custom pattern is evaluated once over all
 * the fields instead of once per field (which took minutes for a large bundle), and the fields are
 * handed over in reading order with one pseudonym state, so the numbering of repeated addresses and the
 * output are what redacting field by field gave. Each event is one item of the batch, which is where
 * its own categories come from.
 *
 * When a custom pattern could not be applied the fields are only partly redacted: nothing is returned
 * and `RedactionIncompleteError` (422) is thrown, so partly redacted text cannot be stored or shown.
 */
export async function redactBundle(
  bundle: CaseBundle,
  options: RedactionOptions,
  pause: () => Promise<void>,
): Promise<BundleRedaction> {
  const caseUnit = plan((mapper) => walkCase(bundle, mapper));
  const eventUnits = bundle.events.map((event) => plan((mapper) => walkEvent(event, mapper)));
  const { resolution } = bundle;
  const resolutionUnit =
    resolution === undefined ? null : plan((mapper) => walkResolution(resolution, mapper));
  await pause();

  const units: Unit<unknown>[] = [
    caseUnit,
    ...eventUnits,
    ...(resolutionUnit === null ? [] : [resolutionUnit]),
  ];
  const batch = redactValues<readonly Part[]>(
    units.map((unit) => unit.parts),
    options,
    createPseudonymState(),
  );
  await pause();
  assertRedactionComplete(batch);

  const redactedFields = (index: number): readonly Part[] => {
    const item = batch.items[index];
    if (item === undefined) throw mismatch();
    return item.value;
  };
  const { caseRecord, participants, syntheticNotice } = caseUnit.build(redactedFields(0));
  const byEventId = Object.create(null) as Record<string, EventRedaction>;
  const events = eventUnits.map((unit, index) => {
    const item = batch.items[1 + index];
    const event = bundle.events[index];
    if (item !== undefined && event !== undefined && item.totalReplacements > 0) {
      byEventId[event.id] = {
        redacted: true,
        categories: item.findings.map((finding) => finding.category),
      };
    }
    return unit.build(redactedFields(1 + index));
  });
  const redactedResolution =
    resolutionUnit === null
      ? undefined
      : resolutionUnit.build(redactedFields(1 + eventUnits.length));

  const redacted: CaseBundle = {
    ...bundle,
    ...(syntheticNotice !== undefined ? { syntheticNotice } : {}),
    case: caseRecord,
    participants,
    events,
    ...(redactedResolution !== undefined ? { resolution: redactedResolution } : {}),
  };
  return {
    bundle: redacted,
    summary: {
      applied: batch.totalReplacements > 0,
      totalReplacements: batch.totalReplacements,
      findings: batch.findings,
    },
    byEventId,
  };
}

/**
 * The reference and the workload are identifiers (other records point at them), so they are not
 * redacted in place. When one of them looks like a credential or personal data the payload is
 * refused instead, because both appear in audit records, logs and URLs. Only the built-in rules
 * decide that: a tenant pattern describes text to hide (typically ticket ids, which is exactly what
 * a case reference is), so applying it here would refuse every case the pattern was written for.
 */
export function credentialLikeIdentifiers(
  bundle: CaseBundle,
  options: RedactionOptions,
): ValidationIssue[] {
  const builtInRules: RedactionOptions = { ...options, customPatterns: [] };
  const probes = [
    ['case.reference', bundle.case.reference],
    ['case.workload', bundle.case.workload],
  ] as const;
  const result = redactTexts(
    probes.map(([, value]) => value),
    builtInRules,
  );
  return probes.flatMap(([path], index) =>
    (result.items[index]?.totalReplacements ?? 0) > 0
      ? [
          errorIssue(
            path,
            'The value looks like a credential or personal data. Use a plain identifier.',
          ),
        ]
      : [],
  );
}
