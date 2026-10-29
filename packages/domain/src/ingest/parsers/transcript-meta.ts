import type { CaseStatus, Severity } from '@caseguard/schemas';
import type { DraftEvent, HeaderMeta, ResolutionDraft } from './draft-types';
import { sourceList } from './draft-meta';
import { codePointLength, safeSlice, type WarningCollector } from './text';
import { isReplySubject, threadKey } from './transcript-email';

const HEADER_KEYS = new Map<string, keyof HeaderMeta>([
  ['title', 'title'],
  ['case title', 'title'],
  ['subject', 'title'],
  ['reference', 'reference'],
  ['case reference', 'reference'],
  ['case', 'reference'],
  ['case id', 'reference'],
  ['case number', 'reference'],
  ['ticket', 'reference'],
  ['product', 'product'],
  ['workload', 'workload'],
  ['severity', 'severity'],
  ['status', 'status'],
  ['customer alias', 'customerAlias'],
]);
const HEADER_LINE = /^\s*([A-Za-z][A-Za-z ]{1,20}?)\s*[:=]\s*(\S.{0,299})$/;
/** Banner keys that are recognised on purpose and carry no case data. */
const BANNER_KEYS: ReadonlySet<string> = new Set(['notice', 'synthetic notice', 'disclaimer']);

function severityOf(value: string): Severity | null {
  const m = /^(?:sev(?:erity)?\s*)?([ABC])\b/i.exec(value.trim());
  return m ? ((m[1] ?? '').toUpperCase() as Severity) : null;
}

function statusOf(value: string): CaseStatus | null {
  const m = /^(open|resolved|closed)\b/i.exec(value.trim());
  return m ? ((m[1] ?? '').toLowerCase() as CaseStatus) : null;
}

/**
 * Reads explicit case details (`Title:`, `Severity:` ...) from the lines before the first
 * message. Anything else in the preamble is reported as ignored rather than interpreted.
 */
export function readHeader(
  preamble: readonly { line: number; text: string }[],
  warnings: WarningCollector,
): { header: HeaderMeta; ignored: number } {
  const header: HeaderMeta = {};
  const ignoredLines: number[] = [];
  for (const { line, text } of preamble) {
    const m = HEADER_LINE.exec(text.slice(0, 340));
    const name = (m?.[1] ?? '').toLowerCase().replace(/\s+/g, ' ');
    if (BANNER_KEYS.has(name)) continue;
    const key = m ? HEADER_KEYS.get(name) : undefined;
    const value = (m?.[2] ?? '').trim();
    if (!key || value.length === 0) {
      ignoredLines.push(line);
      continue;
    }
    if (key === 'severity') {
      const severity = severityOf(value);
      if (severity && !header.severity) header.severity = severity;
      else if (!severity) ignoredLines.push(line);
    } else if (key === 'status') {
      const status = statusOf(value);
      if (status && !header.status) header.status = status;
      else if (!status) ignoredLines.push(line);
    } else if (key === 'workload') {
      if (/^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/.test(value)) header.workload ??= value;
      else ignoredLines.push(line);
    } else {
      header[key] ??= value;
    }
  }
  if (ignoredLines.length > 0) {
    warnings.add(
      'preamble_ignored',
      'info',
      `${ignoredLines.length} line(s) before the first message are not part of any message and were ignored (source ${sourceList(ignoredLines)}).`,
      {
        hint: 'Start the text with the first message, or use "Title:", "Severity:" or "Product:" lines.',
        count: ignoredLines.length,
      },
    );
  }
  return { header, ignored: ignoredLines.length };
}

const SECTION_LABELS =
  /(?:^|[\s.;(])(root\s+cause|workaround|permanent\s+fix|validation)\s*(?::|\u2013|-)\s*/gi;

function sectionsOf(body: string): Map<string, string> {
  const pattern = new RegExp(SECTION_LABELS.source, SECTION_LABELS.flags);
  const found: { name: string; start: number; end: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const name = (match[1] ?? '').toLowerCase().replace(/\s+/g, ' ');
    if (!found.some((f) => f.name === name)) {
      found.push({ name, start: match.index, end: match.index + match[0].length });
    }
  }
  const out = new Map<string, string>();
  found.forEach((section, i) => {
    const next = found[i + 1]?.start ?? body.length;
    const text = trimTail(body.slice(section.end, next)).trim();
    if (text.length > 0) out.set(section.name, text);
  });
  return out;
}

/** Removes trailing whitespace and semicolons without a regex that could backtrack. */
function trimTail(text: string): string {
  let end = text.length;
  while (end > 0 && /[\s;]/.test(text[end - 1] ?? '')) end -= 1;
  return text.slice(0, end);
}

/**
 * Builds the resolution from the last resolution note that contains an explicit "Root cause:"
 * statement. Nothing is inferred: without that label there is no resolution.
 */
export function extractResolution(
  events: readonly DraftEvent[],
  warnings: WarningCollector,
): ResolutionDraft | null {
  const notes = events.filter((e) => e.type === 'resolution_note');
  const note = [...notes].sort((a, b) => b.timestampMs - a.timestampMs || b.order - a.order)[0];
  if (!note) return null;
  const sections = sectionsOf(note.body);
  const rootCause = sections.get('root cause');
  if (!rootCause) {
    warnings.add(
      'resolution_not_extracted',
      'info',
      'A resolution note was found but it has no "Root cause:" statement, so no resolution was recorded.',
      {
        hint: 'Write "Root cause: ...", and optionally "Workaround:" and "Permanent fix:".',
        line: note.at,
      },
    );
    return null;
  }
  const workaround = sections.get('workaround');
  const permanentFix = sections.get('permanent fix');
  return {
    ref: note.ref,
    summary: note.body.trim(),
    rootCause,
    ...(workaround ? { workaround } : {}),
    ...(permanentFix ? { permanentFix } : {}),
  };
}

/** The last explicit "resolved" or "closed" status change, if any. */
export function findStatusEvent(
  events: readonly DraftEvent[],
): { ref: string; status: 'resolved' | 'closed' } | null {
  const changes = events
    .filter(
      (e) => e.type === 'status_change' && /\b(?:resolved|closed)\b/i.test(e.body.slice(0, 200)),
    )
    .sort((a, b) => b.timestampMs - a.timestampMs || b.order - a.order);
  const last = changes[0];
  if (!last) return null;
  return {
    ref: last.ref,
    status: /\bclosed\b/i.test(last.body.slice(0, 200)) ? 'closed' : 'resolved',
  };
}

const SALUTATION_LINE =
  /^\s*(?:hello|hi|hey|dear|good\s+(?:morning|afternoon|evening))\b[^\n]{0,60}$/i;

function firstSentence(body: string): string | null {
  for (const raw of body.split('\n', 12)) {
    const line = raw.trim();
    if (line.length === 0 || SALUTATION_LINE.test(line)) continue;
    const cut = /^(.{5,100}?)(?:[.!?](?:\s|$)|$)/.exec(safeSlice(line, 160));
    const sentence = (cut?.[1] ?? safeSlice(line, 100)).trim();
    return codePointLength(sentence) >= 5 ? sentence : null;
  }
  return null;
}

/** Title taken from the earliest e-mail subject, else the first customer message. */
export function deriveTitle(
  events: readonly DraftEvent[],
  isCustomerSide: (speakerKey: string) => boolean,
): string | null {
  const chronological = [...events].sort(
    (a, b) => a.timestampMs - b.timestampMs || a.order - b.order,
  );
  const withSubject = chronological.find((e) => e.title && e.title.trim().length > 0);
  if (withSubject?.title) {
    const stripped = withSubject.title.replace(/^\s*(?:(?:re|fw|fwd|aw)\s*:\s*)+/i, '').trim();
    if (stripped.length >= 5) return stripped;
  }
  const customer = chronological.find((e) => isCustomerSide(e.speakerKey));
  return customer ? firstSentence(customer.body) : null;
}

const REQUEST_CUE =
  /\?|\b(?:please|could you|can you|would you|kindly|send|provide|share|confirm|let me know)\b/i;
const OUTPUT_TYPES: ReadonlySet<string> = new Set([
  'query_output',
  'diagnostic_result',
  'log_sample',
]);
const LOOKBACK = 50;

/**
 * Links replies only on positive evidence: a `Re:` subject matching an earlier message in the
 * thread, tool output directly after the action that produced it, or a customer message directly
 * after an engineer e-mail that asked for something. Everything else is left unlinked.
 */
export function linkReplies(
  events: readonly DraftEvent[],
  isCustomerSide: (key: string) => boolean,
): void {
  const chronological = [...events].sort(
    (a, b) => a.timestampMs - b.timestampMs || a.order - b.order,
  );
  chronological.forEach((event, i) => {
    if (event.inResponseTo) return;
    const previous = chronological[i - 1];
    if (event.title && isReplySubject(event.title)) {
      const wanted = threadKey(event.title);
      for (let j = i - 1; j >= 0 && j >= i - LOOKBACK; j--) {
        const candidate = chronological[j];
        if (
          candidate?.title &&
          candidate.speakerKey !== event.speakerKey &&
          threadKey(candidate.title) === wanted
        ) {
          event.inResponseTo = candidate.ref;
          event.inResponseToBasis = 'subject_thread';
          return;
        }
      }
    }
    if (!previous) return;
    if (
      OUTPUT_TYPES.has(event.type) &&
      previous.type === 'engineer_action' &&
      previous.speakerKey === event.speakerKey
    ) {
      event.inResponseTo = previous.ref;
      event.inResponseToBasis = 'adjacent_output';
    } else if (
      event.type === 'escalation_response' &&
      previous.type === 'escalation' &&
      previous.speakerKey !== event.speakerKey
    ) {
      event.inResponseTo = previous.ref;
      event.inResponseToBasis = 'adjacent_output';
    } else if (
      (event.type === 'customer_email' || event.type === 'customer_call') &&
      previous.type === 'engineer_email' &&
      isCustomerSide(event.speakerKey) &&
      REQUEST_CUE.test(previous.body.slice(0, 2000))
    ) {
      event.inResponseTo = previous.ref;
      event.inResponseToBasis = 'request_reply';
    }
  });
}
