import {
  CASE_BUNDLE_SCHEMA_VERSION,
  CaseBundleSchema,
  type CaseBundle,
  type CaseStatus,
  type ParticipantRole,
} from '@caseguard/schemas';
import { computeConfidence } from './confidence';
import {
  addTimestampWarnings,
  dedupeTags,
  DEFAULT_PRODUCT,
  pickReference,
  pickTitle,
  sourceList,
  syntheticNoticeFor,
  workloadWarning,
} from './draft-meta';
import { emptyStats, type AssembleInput, type DraftEvent } from './draft-types';
import { friendlyIssues } from './friendly-errors';
import { DEFAULT_WORKLOAD } from './options';
import { aliasFor } from './roles';
import { safeSlice, truncateWithMarker } from './text';
import { formatIso, isFiniteMs } from './timestamps';
import type { DraftFailure, DraftSuccess, EventNote, ParseIssue, SpeakerSummary } from './types';

interface Registered {
  id: string;
  alias: string;
  role: ParticipantRole;
}

/**
 * Turns parsed events into a validated draft bundle. Shared by every text-based parser so
 * ordering, pseudonymisation, id assignment, metadata defaults and schema validation behave
 * identically. The result either passes `CaseBundleSchema` or is a friendly failure.
 */
export function assembleDraft(input: AssembleInput): DraftSuccess | DraftFailure {
  const { options, warnings, source } = input;
  const base = emptyStats(input.stats);
  const failure = (errors: ParseIssue[]): DraftFailure => ({
    ok: false,
    source,
    errors,
    warnings: warnings.toArray(),
    stats: {
      ...base,
      ignoredLines: input.stats.ignoredLines,
      skippedRows: input.stats.skippedRows,
    },
  });
  const draftError = (message: string, hint: string): DraftFailure =>
    failure([{ code: 'draft_invalid', path: '(draft)', message, hint, received: null }]);

  const count = input.events.length;
  if (count === 0) return draftError('No events were found.', 'Check the input format.');
  if (count > options.limits.maxEvents) {
    return failure([
      {
        code: 'too_many_events',
        path: '(input)',
        message: `The input contains ${count} events; the limit is ${options.limits.maxEvents}.`,
        hint: 'Split the case into several parts or remove noise such as automated notifications.',
        received: String(count),
      },
    ]);
  }
  if (input.events.some((e) => !isFiniteMs(e.timestampMs))) {
    return draftError('An event has a timestamp outside the supported range.', 'Check the dates.');
  }

  const sorted = [...input.events].sort(
    (a, b) => a.timestampMs - b.timestampMs || a.order - b.order,
  );
  const reordered = sorted.some((e, i) => e !== input.events[i]);
  if (reordered) {
    warnings.add(
      'events_reordered',
      'info',
      'The events were not in chronological order in the input; they were sorted by timestamp.',
      { hint: 'Newest-first e-mail threads are expected to look like this.' },
    );
  }

  const finalIds = sorted.map((e, i) => e.explicitId ?? options.ids.eventId(i, count));
  const idByRef = new Map(sorted.map((e, i) => [e.ref, finalIds[i] ?? ''] as const));
  const timeByRef = new Map(sorted.map((e) => [e.ref, e.timestampMs] as const));

  const ordinals = new Map<string, number>();
  const registered = new Map<string, Registered>();
  const summaries = new Map<string, SpeakerSummary>();
  for (const e of sorted) {
    const speaker = input.speakers.get(e.speakerKey);
    if (!speaker)
      return draftError('An event refers to an unknown speaker.', 'This is a parser bug.');
    if (!registered.has(speaker.key)) {
      const bucket = speaker.unidentified ? 'unidentified' : speaker.role;
      const ordinal = (ordinals.get(bucket) ?? 0) + 1;
      ordinals.set(bucket, ordinal);
      const entry: Registered = {
        id: options.ids.participantId(speaker.role, ordinal, speaker.unidentified),
        alias: aliasFor(speaker.role, ordinal, speaker.unidentified),
        role: speaker.role,
      };
      registered.set(speaker.key, entry);
      summaries.set(speaker.key, {
        participantId: entry.id,
        alias: entry.alias,
        role: speaker.role,
        roleBasis: speaker.roleBasis,
        label: speaker.label,
        eventCount: 0,
      });
    }
    const summary = summaries.get(speaker.key);
    if (summary) summary.eventCount += 1;
  }
  if (registered.size > options.limits.maxParticipants) {
    return draftError(
      `The input has ${registered.size} distinct speakers; the limit is ${options.limits.maxParticipants}.`,
      'Merge speaker labels that refer to the same person or role.',
    );
  }

  let droppedLinks = 0;
  const events: CaseBundle['events'] = sorted.map((e, i) => {
    let parentId = e.inResponseTo ? idByRef.get(e.inResponseTo) : undefined;
    if (e.inResponseTo && parentId !== undefined) {
      const parentTime = timeByRef.get(e.inResponseTo) ?? Number.POSITIVE_INFINITY;
      if (parentTime > e.timestampMs || parentId === finalIds[i]) {
        parentId = undefined;
        droppedLinks += 1;
      }
    }
    return {
      id: finalIds[i] ?? '',
      timestamp: formatIso(e.timestampMs),
      participantId: registered.get(e.speakerKey)?.id ?? '',
      type: e.type,
      ...(e.channel ? { channel: e.channel } : {}),
      ...(e.title ? { title: safeSlice(e.title, 200) } : {}),
      body: truncateWithMarker(e.body, options.limits.maxBodyChars).text,
      ...(e.action ? { action: bundleAction(e.action) } : {}),
      ...(parentId ? { inResponseTo: parentId } : {}),
      correlationIds: e.correlationIds.slice(0, 20),
    };
  });
  if (droppedLinks > 0) {
    warnings.add(
      'reply_link_dropped',
      'info',
      `${droppedLinks} reply link(s) pointed at a later event and were not kept.`,
      { count: droppedLinks },
    );
  }

  addTimestampWarnings(sorted, options, warnings);
  const defaultedTypes = sorted.filter(
    (e) => e.typeBasis === 'default' || e.typeBasis === 'unknown_speaker',
  );
  if (defaultedTypes.length > 0) {
    warnings.add(
      'event_type_defaulted',
      'info',
      `${defaultedTypes.length} message(s) had no clear type and were recorded as case notes (source ${sourceList(defaultedTypes.map((e) => e.at))}).`,
      {
        hint: 'Add a qualifier after the speaker, for example "Support Engineer (email):" or "(query output):", to state the type.',
        count: defaultedTypes.length,
      },
    );
  }

  const resolutionMs = input.resolution ? timeByRef.get(input.resolution.ref) : undefined;
  const statusEventMs = input.statusEvent ? timeByRef.get(input.statusEvent.ref) : undefined;
  const status: CaseStatus =
    options.status ??
    input.header.status ??
    input.statusEvent?.status ??
    (resolutionMs === undefined ? 'open' : 'resolved');
  const workload = options.workload ?? input.header.workload;
  const product = options.product ?? input.header.product;
  const severity = options.severity ?? input.header.severity;
  const customerAlias = options.customerAlias ?? input.header.customerAlias;

  const defaulted: string[] = [];
  if (!product) defaulted.push(`product ("${DEFAULT_PRODUCT}")`);
  if (!severity) defaulted.push('severity (C)');
  if (!customerAlias) defaulted.push('customerAlias');
  const title = pickTitle(options, input, defaulted, warnings);
  if (defaulted.length > 0) {
    warnings.add(
      'metadata_defaulted',
      'info',
      `Case details were not supplied and were defaulted: ${defaulted.join(', ')}.`,
      { hint: 'Set them before analysis if they matter.' },
    );
  }
  if (!workload) workloadWarning(warnings);

  const notice = syntheticNoticeFor(options);
  const draft: CaseBundle = {
    schemaVersion: CASE_BUNDLE_SCHEMA_VERSION,
    synthetic: options.synthetic,
    ...(notice ? { syntheticNotice: notice } : {}),
    case: {
      reference: pickReference(options, input, warnings),
      title,
      product: product ?? DEFAULT_PRODUCT,
      workload: workload ?? DEFAULT_WORKLOAD,
      severity: severity ?? 'C',
      status,
      openedAt: formatIso(sorted[0]?.timestampMs ?? options.nowMs),
      ...(status !== 'open' && statusEventMs !== undefined
        ? { closedAt: formatIso(statusEventMs) }
        : {}),
      customerAlias:
        customerAlias ?? (options.synthetic ? 'Synthetic customer' : 'Customer (unnamed)'),
      tags: dedupeTags([input.tag, options.synthetic ? 'synthetic' : '', ...options.tags]),
    },
    participants: [...registered.values()].map((p) => ({ id: p.id, role: p.role, alias: p.alias })),
    events,
    ...(input.resolution && resolutionMs !== undefined
      ? {
          resolution: {
            resolvedAt: formatIso(resolutionMs),
            summary: safeSlice(input.resolution.summary, 4000),
            rootCause: safeSlice(input.resolution.rootCause, 4000),
            ...(input.resolution.workaround
              ? { workaround: safeSlice(input.resolution.workaround, 4000) }
              : {}),
            ...(input.resolution.permanentFix
              ? { permanentFix: safeSlice(input.resolution.permanentFix, 4000) }
              : {}),
          },
        }
      : {}),
  };

  const parsed = CaseBundleSchema.safeParse(draft);
  if (!parsed.success) {
    return failure(
      friendlyIssues(parsed.error.issues, draft, options.limits.maxErrors).map((issue) => ({
        ...issue,
        message: `The draft case is not valid: ${issue.message}`,
      })),
    );
  }

  const confidence = computeConfidence({
    eventCount: count,
    unwrittenTimestamps: sorted.filter(
      (e) => e.timestampBasis !== 'explicit' && e.timestampBasis !== 'header',
    ).length,
    assumedZoneEvents: sorted.filter((e) => e.zoneAssumed).length,
    unidentifiedEvents: sorted.filter((e) => input.speakers.get(e.speakerKey)?.unidentified).length,
    defaultedTypeEvents: defaultedTypes.length,
    ignoredLines: input.stats.ignoredLines,
    nonBlankLines: input.nonBlankLines,
    reordered,
    truncatedBodies: input.truncatedBodies,
    mergedSpeakers: input.mergedSpeakers,
  });
  const notes: EventNote[] = sorted.map((e, i) => ({
    eventId: finalIds[i] ?? '',
    at: e.at,
    typeBasis: e.typeBasis,
    timestampBasis: e.timestampBasis,
    inResponseToBasis: parsed.data.events[i]?.inResponseTo ? e.inResponseToBasis : null,
  }));

  return {
    ok: true,
    source,
    bundle: parsed.data,
    warnings: warnings.toArray(),
    confidence,
    speakers: [...summaries.values()],
    eventNotes: notes,
    stats: {
      ...base,
      events: count,
      participants: registered.size,
      ignoredLines: input.stats.ignoredLines,
      skippedRows: input.stats.skippedRows,
    },
  };
}

function bundleAction(action: NonNullable<DraftEvent['action']>) {
  return {
    label: safeSlice(action.label, 200),
    customerEffort: action.customerEffort ?? 'none',
    destructive: action.destructive ?? false,
    ...(action.actionKey ? { actionKey: safeSlice(action.actionKey, 80) } : {}),
    ...(action.durationMinutes === undefined ? {} : { durationMinutes: action.durationMinutes }),
  } as const;
}
