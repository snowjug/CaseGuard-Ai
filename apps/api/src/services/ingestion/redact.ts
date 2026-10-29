import {
  REDACTION_CATEGORIES,
  type BundleEvent,
  type BundleResolution,
  type CaseBundle,
  type RedactionCategory,
  type RedactionConfig,
  type RedactionFinding,
  type RedactionSummary,
  type StructuredRecord,
  type ValidationIssue,
} from '@caseguard/schemas';
import {
  SECRET_REDACTION_CATEGORIES,
  createPseudonymState,
  redactText,
  redactValue,
  type PseudonymState,
  type RedactionOptions,
} from '@caseguard/security';
import { errorIssue } from './issues';
import type { EventRedaction } from './types';

/** How many events are processed between two yields to the event loop (large inputs only). */
const YIELD_EVERY = 50;

export interface BundleRedaction {
  readonly bundle: CaseBundle;
  readonly summary: RedactionSummary;
  /** Only events with at least one replacement have an entry. Null-prototype map. */
  readonly byEventId: Record<string, EventRedaction>;
  /** Operator-facing remarks of the engine (for example a custom pattern that was skipped). */
  readonly notes: readonly string[];
}

/**
 * Credentials are redacted whatever a tenant switched off in governance: settings can narrow the
 * personal-data categories, never the secret ones. Data that is not declared synthetic also loses the
 * exemption for reserved test values (private addresses, example domains): they are real there.
 */
export function redactionOptionsFor(config: RedactionConfig, synthetic: boolean): RedactionOptions {
  const enabled = new Set<RedactionCategory>([
    ...config.enabledCategories,
    ...SECRET_REDACTION_CATEGORIES,
  ]);
  return {
    enabledCategories: [...enabled],
    customPatterns: config.customPatterns,
    redactReservedValues: !synthetic,
  };
}

/** Counts per category, never the matched text. */
class Tally {
  private readonly counts = new Map<RedactionCategory, number>();
  private readonly placeholders = new Map<RedactionCategory, string>();
  readonly notes = new Set<string>();

  add(findings: readonly RedactionFinding[], notes: readonly string[]): void {
    for (const finding of findings) {
      this.counts.set(finding.category, (this.counts.get(finding.category) ?? 0) + finding.count);
      if (!this.placeholders.has(finding.category)) {
        this.placeholders.set(finding.category, finding.placeholder);
      }
    }
    for (const note of notes) this.notes.add(note);
  }

  merge(other: Tally): void {
    this.add(other.findings(), [...other.notes]);
  }

  get total(): number {
    let sum = 0;
    for (const count of this.counts.values()) sum += count;
    return sum;
  }

  categories(): RedactionCategory[] {
    return REDACTION_CATEGORIES.filter((category) => (this.counts.get(category) ?? 0) > 0);
  }

  findings(): RedactionFinding[] {
    return this.categories().map((category) => ({
      category,
      count: this.counts.get(category) ?? 0,
      placeholder: this.placeholders.get(category) ?? `[REDACTED:${category}]`,
    }));
  }
}

/** One pseudonym state per case: the same address gets the same number everywhere in it. */
class Redactor {
  constructor(
    private readonly options: RedactionOptions,
    private readonly state: PseudonymState,
  ) {}

  text(value: string, into: Tally): string {
    const result = redactText(value, this.options, this.state);
    into.add(result.findings, result.notes);
    return result.text;
  }

  /** String values under secret-named keys (`password`, `apiKey`, ...) are replaced outright. */
  record(value: StructuredRecord, into: Tally): StructuredRecord {
    const result = redactValue(value, this.options, this.state);
    into.add(result.findings, result.notes);
    return result.value;
  }
}

function redactEvent(event: BundleEvent, redactor: Redactor, into: Tally): BundleEvent {
  return {
    ...event,
    ...(event.title !== undefined ? { title: redactor.text(event.title, into) } : {}),
    body: redactor.text(event.body, into),
    ...(event.action !== undefined
      ? { action: { ...event.action, label: redactor.text(event.action.label, into) } }
      : {}),
    correlationIds: event.correlationIds.map((id) => redactor.text(id, into)),
    ...(event.structured !== undefined
      ? { structured: redactor.record(event.structured, into) }
      : {}),
  };
}

function redactResolution(
  resolution: BundleResolution,
  redactor: Redactor,
  into: Tally,
): BundleResolution {
  return {
    ...resolution,
    summary: redactor.text(resolution.summary, into),
    rootCause: redactor.text(resolution.rootCause, into),
    ...(resolution.workaround !== undefined
      ? { workaround: redactor.text(resolution.workaround, into) }
      : {}),
    ...(resolution.permanentFix !== undefined
      ? { permanentFix: redactor.text(resolution.permanentFix, into) }
      : {}),
    ...(resolution.validation !== undefined
      ? {
          validation: {
            ...resolution.validation,
            method: redactor.text(resolution.validation.method, into),
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
 */
export async function redactBundle(
  bundle: CaseBundle,
  options: RedactionOptions,
  pause: () => Promise<void>,
): Promise<BundleRedaction> {
  const redactor = new Redactor(options, createPseudonymState());
  const total = new Tally();

  const caseTally = new Tally();
  const caseRecord = {
    ...bundle.case,
    title: redactor.text(bundle.case.title, caseTally),
    product: redactor.text(bundle.case.product, caseTally),
    customerAlias: redactor.text(bundle.case.customerAlias, caseTally),
    tags: bundle.case.tags.map((tag) => redactor.text(tag, caseTally)),
  };
  const participants = bundle.participants.map((participant) => ({
    ...participant,
    alias: redactor.text(participant.alias, caseTally),
  }));
  const syntheticNotice =
    bundle.syntheticNotice === undefined
      ? undefined
      : redactor.text(bundle.syntheticNotice, caseTally);
  total.merge(caseTally);

  const byEventId = Object.create(null) as Record<string, EventRedaction>;
  const events: BundleEvent[] = [];
  for (const [index, event] of bundle.events.entries()) {
    const eventTally = new Tally();
    events.push(redactEvent(event, redactor, eventTally));
    if (eventTally.total > 0) {
      byEventId[event.id] = { redacted: true, categories: eventTally.categories() };
    }
    total.merge(eventTally);
    if (index % YIELD_EVERY === YIELD_EVERY - 1) await pause();
  }

  const resolutionTally = new Tally();
  const resolution =
    bundle.resolution === undefined
      ? undefined
      : redactResolution(bundle.resolution, redactor, resolutionTally);
  total.merge(resolutionTally);

  const redacted: CaseBundle = {
    ...bundle,
    ...(syntheticNotice !== undefined ? { syntheticNotice } : {}),
    case: caseRecord,
    participants,
    events,
    ...(resolution !== undefined ? { resolution } : {}),
  };
  return {
    bundle: redacted,
    summary: {
      applied: total.total > 0,
      totalReplacements: total.total,
      findings: total.findings(),
    },
    byEventId,
    notes: [...total.notes],
  };
}

/**
 * The reference and the workload are identifiers (other records point at them), so they are not
 * redacted in place. When one of them looks like a credential or personal data the payload is
 * refused instead, because both appear in audit records, logs and URLs.
 */
export function credentialLikeIdentifiers(
  bundle: CaseBundle,
  options: RedactionOptions,
): ValidationIssue[] {
  const probes: readonly (readonly [string, string])[] = [
    ['case.reference', bundle.case.reference],
    ['case.workload', bundle.case.workload],
  ];
  return probes
    .filter(([, value]) => redactText(value, options).totalReplacements > 0)
    .map(([path]) =>
      errorIssue(
        path,
        'The value looks like a credential or personal data. Use a plain identifier.',
      ),
    );
}
