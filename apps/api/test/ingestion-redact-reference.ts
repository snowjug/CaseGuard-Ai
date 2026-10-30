import {
  REDACTION_CATEGORIES,
  type BundleEvent,
  type BundleResolution,
  type CaseBundle,
  type RedactionCategory,
  type RedactionFinding,
  type RedactionSummary,
  type StructuredRecord,
} from '@caseguard/schemas';
import {
  createPseudonymState,
  redactText,
  redactValue,
  type PseudonymState,
  type RedactionOptions,
} from '@caseguard/security';
import type { EventRedaction } from '../src/services/ingestion/types';

/*
 * The way the ingestion service redacted a bundle before it was batched: one call per string, one
 * pseudonym state for the whole bundle, tallies per event. It is kept here as the reference the batched
 * implementation must equal byte for byte (the stored payload, the summary and the per-event
 * categories). It uses the deprecated per-string functions on purpose.
 */

class Tally {
  private readonly counts = new Map<RedactionCategory, number>();
  private readonly placeholders = new Map<RedactionCategory, string>();

  add(findings: readonly RedactionFinding[]): void {
    for (const finding of findings) {
      this.counts.set(finding.category, (this.counts.get(finding.category) ?? 0) + finding.count);
      if (!this.placeholders.has(finding.category)) {
        this.placeholders.set(finding.category, finding.placeholder);
      }
    }
  }

  merge(other: Tally): void {
    this.add(other.findings());
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

class PerString {
  constructor(
    private readonly options: RedactionOptions,
    private readonly state: PseudonymState,
  ) {}

  text(value: string, into: Tally): string {
    const result = redactText(value, this.options, this.state);
    into.add(result.findings);
    return result.text;
  }

  record(value: StructuredRecord, into: Tally): StructuredRecord {
    const result = redactValue(value, this.options, this.state);
    into.add(result.findings);
    return result.value;
  }
}

function redactEvent(event: BundleEvent, redactor: PerString, into: Tally): BundleEvent {
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
  redactor: PerString,
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

export interface ReferenceRedaction {
  readonly bundle: CaseBundle;
  readonly summary: RedactionSummary;
  readonly byEventId: Record<string, EventRedaction>;
}

export function referenceRedactBundle(
  bundle: CaseBundle,
  options: RedactionOptions,
): ReferenceRedaction {
  const redactor = new PerString(options, createPseudonymState());
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
  for (const event of bundle.events) {
    const eventTally = new Tally();
    events.push(redactEvent(event, redactor, eventTally));
    if (eventTally.total > 0) {
      byEventId[event.id] = { redacted: true, categories: eventTally.categories() };
    }
    total.merge(eventTally);
  }

  const resolutionTally = new Tally();
  const resolution =
    bundle.resolution === undefined
      ? undefined
      : redactResolution(bundle.resolution, redactor, resolutionTally);
  total.merge(resolutionTally);

  return {
    bundle: {
      ...bundle,
      ...(syntheticNotice !== undefined ? { syntheticNotice } : {}),
      case: caseRecord,
      participants,
      events,
      ...(resolution !== undefined ? { resolution } : {}),
    },
    summary: {
      applied: total.total > 0,
      totalReplacements: total.total,
      findings: total.findings(),
    },
    byEventId,
  };
}
