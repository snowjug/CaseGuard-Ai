import { CUSTOMER_SIDE_ROLES } from '@caseguard/schemas';
import { assembleDraft } from './draft';
import { emptyStats, type DraftEvent } from './draft-types';
import { sourceList } from './draft-meta';
import { inferEventType } from './event-types';
import { resolveDraftOptions } from './options';
import { inferRole } from './roles';
import { SpeakerBook } from './speakers';
import {
  reportSanitization,
  sanitizeText,
  truncateWithMarker,
  utf8Bytes,
  WarningCollector,
  displayValue,
} from './text';
import { stripQuotedText, tidyBody } from './transcript-email';
import { scanTurns, type RawTurn } from './transcript-lines';
import {
  deriveTitle,
  extractResolution,
  findStatusEvent,
  linkReplies,
  readHeader,
} from './transcript-meta';
import { fillTurnTimes, resolveTurnTimes } from './transcript-time';
import type { DraftFailure, ParseIssueCode, ParseResult, TranscriptOptions } from './types';

export const TRANSCRIPT_FORMAT_HINT =
  'Start each message with a timestamp and a speaker, for example "[2026-03-09 09:12] Customer: ...", "2026-03-09T09:12:00Z - Engineer - ..." or "09:12 Customer: ..." (with a defaultDate), or paste e-mails that have From:, Sent: and Subject: lines.';

/**
 * Converts a pasted case discussion into a draft case bundle. Pure and bounded: no I/O, the
 * clock and ids come from the options, and every loop is linear in the input size. Anything the
 * text does not state (time zone, date, role, event type) is defaulted conservatively and
 * reported as a warning; the draft is validated against `CaseBundleSchema` before it is returned.
 *
 * @throws IngestParseError only when the *options* are invalid. Bad input never throws.
 */
export function parsePastedTranscript(text: string, options: TranscriptOptions): ParseResult {
  const opts = resolveDraftOptions(options);
  const { limits } = opts;
  const warnings = new WarningCollector(limits.maxWarnings);
  const counts = {
    inputChars: typeof text === 'string' ? text.length : 0,
    inputBytes: 0,
    lines: 0,
  };
  const fail = (
    code: ParseIssueCode,
    message: string,
    hint: string,
    received: string | null = null,
  ): DraftFailure => ({
    ok: false,
    source: 'pasted_transcript',
    errors: [{ code, path: '(input)', message, hint, received }],
    warnings: warnings.toArray(),
    stats: emptyStats(counts),
  });

  if (typeof text !== 'string') {
    return fail(
      'input_not_text',
      'The pasted text is missing or is not text.',
      'Send the transcript as a string.',
    );
  }
  if (text.length > limits.maxTranscriptChars) {
    return fail(
      'input_too_large',
      `The pasted text has ${text.length} characters; the limit is ${limits.maxTranscriptChars}.`,
      'Paste fewer messages at a time, or upload the case as a structured file.',
      `${text.length} characters`,
    );
  }
  counts.inputBytes = utf8Bytes(text);
  const sanitized = sanitizeText(text);
  reportSanitization(sanitized, warnings);
  if (sanitized.text.trim().length === 0) {
    return fail('input_empty', 'The pasted text is empty.', TRANSCRIPT_FORMAT_HINT);
  }
  const lines = sanitized.text.split('\n');
  counts.lines = lines.length;
  if (lines.length > limits.maxLines) {
    return fail(
      'too_many_lines',
      `The pasted text has ${lines.length} lines; the limit is ${limits.maxLines}.`,
      'Paste fewer messages at a time.',
      `${lines.length} lines`,
    );
  }

  const scan = scanTurns(lines, {
    maxTurns: limits.maxEvents,
    extraKnown: Object.keys(opts.speakerRoles ?? {}),
  });
  if (scan.tooManyTurns) {
    return fail(
      'too_many_events',
      `The pasted text contains more than ${limits.maxEvents} messages.`,
      'Split the case into several parts or remove automated notifications.',
    );
  }
  const turns = scan.items.filter((item): item is RawTurn => item.kind !== 'date');
  if (turns.length === 0) {
    const first = lines.find((l) => l.trim().length > 0) ?? '';
    return fail(
      'no_turns',
      'No messages were found in the pasted text.',
      TRANSCRIPT_FORMAT_HINT,
      displayValue(first, 60) || null,
    );
  }
  const times = fillTurnTimes(resolveTurnTimes(scan.items, opts, warnings));
  if (!times) {
    return fail(
      'no_timestamps',
      'Messages were found but none has a readable timestamp, so the order and timing of events cannot be established.',
      TRANSCRIPT_FORMAT_HINT,
    );
  }

  const book = new SpeakerBook(limits.maxParticipants);
  const events: DraftEvent[] = [];
  const quoted = { lines: 0, at: [] as number[] };
  const truncatedAt: number[] = [];
  const emptyAt: number[] = [];

  turns.forEach((turn, i) => {
    const time = times[i];
    if (!time) return;
    const stripped = stripQuotedText(tidyBody(turn.bodyLines));
    const tidy = tidyBody(stripped.lines).join('\n');
    const subject = turn.subject?.trim() || null;
    if (tidy.trim().length === 0 && !subject) {
      emptyAt.push(turn.line);
      return;
    }
    if (stripped.removed > 0) {
      quoted.lines += stripped.removed;
      quoted.at.push(turn.line);
    }
    const bounded = truncateWithMarker(tidy, limits.maxBodyChars);
    if (bounded.cut > 0) truncatedAt.push(turn.line);
    const inference = inferRole(turn.label, opts.speakerRoles);
    const speaker = book.register(turn.label, inference, turn.line, warnings);
    const decision = inferEventType({
      role: speaker.role,
      roleKnown: !speaker.unidentified,
      qualifier: turn.label.qualifier,
      body: bounded.text,
      isEmailBlock: turn.kind === 'email',
    });
    events.push({
      ref: `t${turn.index}`,
      order: turn.index,
      at: turn.line,
      timestampMs: time.ms,
      timestampBasis: time.basis,
      zoneAssumed: time.zoneAssumed,
      speakerKey: speaker.key,
      type: decision.type,
      typeBasis: decision.basis,
      title: subject,
      body: bounded.text,
      channel: turn.kind === 'email' ? 'email' : decision.type === 'customer_call' ? 'phone' : null,
      action: null,
      inResponseTo: null,
      inResponseToBasis: null,
      correlationIds: [],
      explicitId: null,
    });
  });

  if (events.length === 0) {
    return fail('no_turns', 'Every message in the pasted text was empty.', TRANSCRIPT_FORMAT_HINT);
  }
  if (quoted.lines > 0) {
    warnings.add(
      'quoted_text_removed',
      'info',
      `Removed ${quoted.lines} line(s) of quoted earlier messages from ${quoted.at.length} message(s) (source ${sourceList(quoted.at)}); only each new reply was kept.`,
      { count: quoted.lines },
    );
  }
  if (truncatedAt.length > 0) {
    warnings.add(
      'body_truncated',
      'warning',
      `${truncatedAt.length} message(s) exceeded ${limits.maxBodyChars} characters and were cut (source ${sourceList(truncatedAt)}).`,
      { hint: 'Paste long logs separately or attach them as a file.', count: truncatedAt.length },
    );
  }
  if (emptyAt.length > 0) {
    warnings.add(
      'empty_message_skipped',
      'info',
      `${emptyAt.length} message(s) had no text and were skipped (source ${sourceList(emptyAt)}).`,
      { count: emptyAt.length },
    );
  }
  if (scan.orphanLines > 0) {
    warnings.add(
      'lines_without_speaker',
      'info',
      `${scan.orphanLines} timestamped line(s) had no speaker label and were kept as part of the previous message.`,
      { hint: 'Write "[time] Speaker: text" to start a new message.', count: scan.orphanLines },
    );
  }
  if (scan.unclosedFence) {
    warnings.add(
      'unclosed_code_fence',
      'info',
      'A ``` code fence was opened but never closed; the rest of the text was kept as part of one message.',
    );
  }

  const isCustomerSide = (key: string): boolean => {
    const speaker = book.speakers.get(key);
    return !!speaker && !speaker.unidentified && CUSTOMER_SIDE_ROLES.includes(speaker.role);
  };
  linkReplies(events, isCustomerSide);
  const { header, ignored } = readHeader(scan.preamble, warnings);

  return assembleDraft({
    source: 'pasted_transcript',
    options: opts,
    speakers: book.speakers,
    events,
    warnings,
    stats: {
      inputChars: counts.inputChars,
      inputBytes: counts.inputBytes,
      lines: counts.lines,
      ignoredLines: ignored + emptyAt.length,
      skippedRows: 0,
    },
    nonBlankLines: scan.nonBlankLines,
    header,
    derivedTitle: deriveTitle(events, isCustomerSide),
    tag: 'pasted-transcript',
    referenceSeed: sanitized.text,
    resolution: extractResolution(events, warnings),
    statusEvent: findStatusEvent(events),
    mergedSpeakers: book.merged,
    truncatedBodies: truncatedAt.length,
  });
}
