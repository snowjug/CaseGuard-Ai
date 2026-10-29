import { isPlausibleLabel, splitSpeakerLabel, type SpeakerLabel } from './roles';
import { labelKey } from './text';
import {
  matchDateOnlyLine,
  matchLinePrefix,
  scanWholeValue,
  type ScannedMoment,
} from './timestamps';
import { readEmailHeaders } from './transcript-email';

export interface RawTurn {
  kind: 'line' | 'email';
  /** Position among turns, in source order. */
  index: number;
  /** 1-based source line where the turn starts. */
  line: number;
  label: SpeakerLabel;
  /** The stamp as written; `null` when the turn has none (it will inherit one). */
  scanned: ScannedMoment | null;
  /** Header text that failed to parse as a time, for the warning. */
  unparsedStamp: string | null;
  subject: string | null;
  bodyLines: string[];
}

export interface DateMarker {
  kind: 'date';
  line: number;
  scanned: ScannedMoment;
}

export type Item = RawTurn | DateMarker;

export interface TurnScan {
  items: Item[];
  /** Non-blank lines before the first turn. */
  preamble: { line: number; text: string }[];
  /** Stamped lines that had no usable speaker and were folded into the previous message. */
  orphanLines: number;
  nonBlankLines: number;
  tooManyTurns: boolean;
  /** A ``` fence was opened and never closed. */
  unclosedFence: boolean;
}

type LineClass =
  | { kind: 'blank' | 'text' | 'consumed' }
  | { kind: 'date'; scanned: ScannedMoment }
  | { kind: 'stamped'; scanned: ScannedMoment; label: SpeakerLabel; text: string }
  | { kind: 'stamped_nolabel'; scanned: ScannedMoment }
  | { kind: 'label'; label: SpeakerLabel; text: string }
  | { kind: 'email'; from: string; sent: string | null; subject: string | null };

const SPACED_DASH = /\s[-\u2013\u2014]\s/;

/**
 * Splits `Label: text` or `Label - text` into the speaker label and the first line of the message.
 * Only the first 200 characters are searched for the delimiter and the label must look like a
 * speaker (short, word-like, not a field name such as "Note" or "Error").
 */
export function extractLabel(rest: string): { label: SpeakerLabel; text: string } | null {
  const head = rest.slice(0, 200);
  const colon = head.indexOf(':');
  const dash = SPACED_DASH.exec(head);
  let cut = -1;
  let length = 0;
  if (colon >= 0 && (!dash || colon < dash.index)) {
    cut = colon;
    length = 1;
  } else if (dash) {
    cut = dash.index;
    length = dash[0].length;
  }
  if (cut <= 0) return null;
  const label = splitSpeakerLabel(head.slice(0, cut));
  if (!isPlausibleLabel(label)) return null;
  const text = rest.slice(cut + length);
  if (length === 1 && text.startsWith('//')) return null;
  return { label, text: text.trim() };
}

function knownKeys(label: SpeakerLabel): string[] {
  const keys = [labelKey(label.name)];
  if (label.address) keys.push(label.address);
  return keys.filter((k) => k.length > 0);
}

/**
 * Finds the message boundaries of a pasted transcript. A stamped `Label: text` line always starts
 * a message; an unstamped `Label: text` line starts one only when that label also appears on a
 * stamped line, so prose such as "System: Windows 11" inside a message cannot split it.
 */
export function scanTurns(
  lines: readonly string[],
  options: { maxTurns: number; extraKnown: readonly string[] },
): TurnScan {
  const classes: LineClass[] = new Array<LineClass>(lines.length);
  const known = new Set<string>(options.extraKnown.map((k) => labelKey(k)));
  let nonBlankLines = 0;
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim().length === 0) {
      classes[i] = { kind: 'blank' };
      continue;
    }
    nonBlankLines += 1;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      classes[i] = { kind: 'text' };
      continue;
    }
    if (inFence) {
      classes[i] = { kind: 'text' };
      continue;
    }
    const email = readEmailHeaders(lines, i);
    if (email) {
      classes[i] = { kind: 'email', from: email.from, sent: email.sent, subject: email.subject };
      for (let j = i + 1; j < i + email.length; j++) {
        classes[j] = { kind: 'consumed' };
        nonBlankLines += 1;
      }
      i += email.length - 1;
      continue;
    }
    const stamped = matchLinePrefix(line);
    if (stamped) {
      const extracted = extractLabel(stamped.rest);
      if (extracted) {
        classes[i] = { kind: 'stamped', scanned: stamped.scanned, ...extracted };
        for (const key of knownKeys(extracted.label)) known.add(key);
      } else {
        classes[i] = { kind: 'stamped_nolabel', scanned: stamped.scanned };
      }
      continue;
    }
    const dateOnly = matchDateOnlyLine(line);
    if (dateOnly) {
      classes[i] = { kind: 'date', scanned: dateOnly };
      continue;
    }
    const labelled = extractLabel(line.trim());
    classes[i] = labelled ? { kind: 'label', ...labelled } : { kind: 'text' };
  }

  const items: Item[] = [];
  const preamble: TurnScan['preamble'] = [];
  const unclosedFence = inFence;
  let orphanLines = 0;
  let turnCount = 0;
  let current: RawTurn | null = null;

  const start = (
    kind: RawTurn['kind'],
    line: number,
    label: SpeakerLabel,
    scanned: ScannedMoment | null,
    subject: string | null,
    first: string | null,
    unparsedStamp: string | null,
  ): RawTurn => {
    const turn: RawTurn = {
      kind,
      index: turnCount,
      line,
      label,
      scanned,
      unparsedStamp,
      subject,
      bodyLines: first === null ? [] : [first],
    };
    turnCount += 1;
    items.push(turn);
    return turn;
  };

  for (let i = 0; i < lines.length; i++) {
    const cls = classes[i];
    const line = lines[i] ?? '';
    if (turnCount > options.maxTurns) {
      return { items, preamble, orphanLines, nonBlankLines, tooManyTurns: true, unclosedFence };
    }
    switch (cls?.kind) {
      case 'blank':
        current?.bodyLines.push('');
        break;
      case 'consumed':
        break;
      case 'date':
        items.push({ kind: 'date', line: i + 1, scanned: cls.scanned });
        break;
      case 'email': {
        const scanned = cls.sent === null ? null : scanWholeValue(cls.sent);
        current = start(
          'email',
          i + 1,
          splitSpeakerLabel(cls.from),
          scanned,
          cls.subject,
          null,
          cls.sent !== null && scanned === null ? cls.sent : null,
        );
        break;
      }
      case 'stamped':
        current = start('line', i + 1, cls.label, cls.scanned, null, cls.text, null);
        break;
      case 'stamped_nolabel':
        if (current) {
          current.bodyLines.push(line);
          orphanLines += 1;
        } else {
          preamble.push({ line: i + 1, text: line });
        }
        break;
      case 'label': {
        const accepted = knownKeys(cls.label).some((k) => known.has(k));
        if (accepted) current = start('line', i + 1, cls.label, null, null, cls.text, null);
        else if (current) current.bodyLines.push(line);
        else preamble.push({ line: i + 1, text: line });
        break;
      }
      default:
        if (current) current.bodyLines.push(line);
        else preamble.push({ line: i + 1, text: line });
    }
  }
  return { items, preamble, orphanLines, nonBlankLines, tooManyTurns: false, unclosedFence };
}
