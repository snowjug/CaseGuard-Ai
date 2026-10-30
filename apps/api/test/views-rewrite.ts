import { normalizeBundle, type NormalizedCase } from '@caseguard/domain';
import type {
  BundleEvent,
  BundleResolution,
  CaseBundle,
  StructuredRecord,
} from '@caseguard/schemas';
import type { TenantRepositories } from '../src/db';
import { toIngestInput } from './support/samples';

/**
 * Helpers of the metamorphic temporal-integrity test: a copy of a stored case bundle whose
 * everything after one instant is rewritten, the ingestion of such a copy through the real
 * normaliser and repositories, and the comparison of two serialized responses.
 */

/** The prefix every rewritten text starts with, so a leak of rewritten content is easy to name. */
export const FUTURE_MARK = 'FUTUREMARK';

/** Rewritten events and the rewritten resolution move this far (9 days 7 h 13 min) into the future. */
export const FUTURE_SHIFT_MS = 9 * 86_400_000 + 7 * 3_600_000 + 13 * 60_000;

/** The reverse of a text under a marker: nothing of the original survives, only its length. */
const scramble = (text: string, mark: string, max: number): string =>
  `${mark} ${[...text].reverse().join('')}`.slice(0, max);

function rewriteStructured(record: StructuredRecord): StructuredRecord {
  const out: StructuredRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') out[key] = FUTURE_MARK;
    else if (typeof value === 'number') out[key] = value + 1000;
    else if (typeof value === 'boolean') out[key] = !value;
    else if (Array.isArray(value)) out[key] = [FUTURE_MARK];
    else out[key] = null;
  }
  return out;
}

function rewriteEvent(event: BundleEvent, shiftMs: number): BundleEvent {
  const mark = `${FUTURE_MARK}-${event.id}`;
  return {
    id: event.id,
    participantId: event.participantId,
    type: event.type,
    ...(event.channel === undefined ? {} : { channel: event.channel }),
    ...(event.inResponseTo === undefined ? {} : { inResponseTo: event.inResponseTo }),
    timestamp: new Date(Date.parse(event.timestamp) + shiftMs).toISOString(),
    ...(event.title === undefined ? {} : { title: scramble(event.title, mark, 200) }),
    body: scramble(event.body, mark, 20_000),
    correlationIds: event.correlationIds.map((_, index) => `${mark}-${index}`.slice(0, 80)),
    ...(event.structured === undefined ? {} : { structured: rewriteStructured(event.structured) }),
    ...(event.action === undefined
      ? {}
      : {
          action: {
            label: scramble(event.action.label, mark, 200),
            customerEffort: event.action.customerEffort,
            destructive: event.action.destructive,
            ...(event.action.durationMinutes === undefined
              ? {}
              : { durationMinutes: event.action.durationMinutes + 7 }),
          },
        }),
    ...(event.ai === undefined
      ? {}
      : {
          ai: {
            ...event.ai,
            promptTokens: event.ai.promptTokens + 1000,
            completionTokens: event.ai.completionTokens + 500,
          },
        }),
  };
}

function rewriteResolution(
  resolution: BundleResolution,
  cutMs: number,
  shiftMs: number,
  rootKeys: readonly string[],
): BundleResolution {
  const shifted = (iso: string): string => new Date(Date.parse(iso) + shiftMs).toISOString();
  const resolvedLater = Date.parse(resolution.resolvedAt) > cutMs;
  const validation = resolution.validation;
  const validatedLater = validation !== undefined && Date.parse(validation.validatedAt) > cutMs;
  const otherKey = rootKeys.find((key) => key !== resolution.rootCauseHypothesisKey);
  return {
    ...resolution,
    ...(resolvedLater
      ? {
          resolvedAt: shifted(resolution.resolvedAt),
          summary: scramble(resolution.summary, FUTURE_MARK, 4000),
          rootCause: scramble(resolution.rootCause, FUTURE_MARK, 4000),
          ...(resolution.workaround === undefined
            ? {}
            : { workaround: scramble(resolution.workaround, FUTURE_MARK, 4000) }),
          ...(resolution.permanentFix === undefined
            ? {}
            : { permanentFix: scramble(resolution.permanentFix, FUTURE_MARK, 4000) }),
          ...(otherKey === undefined ? {} : { rootCauseHypothesisKey: otherKey }),
        }
      : {}),
    ...(validation !== undefined && (validatedLater || resolvedLater)
      ? {
          validation: {
            ...validation,
            validatedAt: shifted(validation.validatedAt),
            method: scramble(validation.method, FUTURE_MARK, 1000),
          },
        }
      : {}),
  };
}

/**
 * A copy of the bundle in which everything recorded after `cutMs` is rewritten: every later event's
 * text, title, structured data, action, usage and instant (all moved later by `shiftMs`, which keeps
 * their order and keeps them after the cut), and the resolution and the closing time when they are
 * later too. Everything up to the cut is untouched. With `shiftMs` of 0 the instants stay where they
 * were and only the content changes (a control: the window then really sees different text).
 */
export function rewriteAfter(
  bundle: CaseBundle,
  cutMs: number,
  rootKeys: readonly string[],
  shiftMs: number = FUTURE_SHIFT_MS,
): CaseBundle {
  const copy: CaseBundle = structuredClone(bundle);
  copy.events = copy.events.map((event) =>
    Date.parse(event.timestamp) > cutMs ? rewriteEvent(event, shiftMs) : event,
  );
  if (copy.resolution !== undefined) {
    copy.resolution = rewriteResolution(copy.resolution, cutMs, shiftMs, rootKeys);
  }
  if (copy.case.closedAt !== undefined && Date.parse(copy.case.closedAt) > cutMs) {
    copy.case.closedAt = new Date(Date.parse(copy.case.closedAt) + shiftMs).toISOString();
  }
  return copy;
}

/** Ingests a bundle exactly as the sample loader does: the real normaliser, then the repository. */
export async function ingestBundle(
  repos: TenantRepositories,
  tenantId: string,
  caseId: string,
  bundle: CaseBundle,
): Promise<NormalizedCase> {
  const payload = JSON.stringify(bundle);
  const normalized = normalizeBundle(bundle, {
    tenantId,
    caseId,
    sourceId: `src_${caseId}`,
    createdBy: 'system:test',
    now: '2026-10-29T00:00:00.000Z',
    sourceKind: 'builtin_sample',
    storedPayload: payload,
    redactionReplacements: 0,
  });
  await repos.cases.ingest(toIngestInput(normalized, payload));
  return normalized;
}

/**
 * Masks what names a world or a request rather than the case: the tenant id, the analysis run id, the
 * ids derived from the run id (quality assessments and metric estimates carry the run in their id) and
 * the moment a view was generated (the clock of the request, not data of the case).
 */
export function maskWorld(body: string, tenants: readonly [from: string, to: string]): string {
  return body
    .replaceAll(tenants[0], tenants[1])
    .replace(/\brun_[0-9A-Za-z]+/g, 'run_MASKED')
    .replace(/\b(qa|met)_[0-9a-f]{16,}\b/g, '$1_MASKED')
    .replace(/"generatedAt":"[^"]*"/g, '"generatedAt":"MASKED"');
}

export interface Difference {
  readonly at: number;
  readonly real: string;
  readonly copy: string;
}

/** Where two serialized responses first differ, with a little context, or null when identical. */
export function firstDifference(real: string, copy: string): Difference | null {
  if (real === copy) return null;
  let at = 0;
  const limit = Math.min(real.length, copy.length);
  while (at < limit && real[at] === copy[at]) at += 1;
  const from = Math.max(0, at - 60);
  return { at, real: real.slice(from, at + 100), copy: copy.slice(from, at + 100) };
}
