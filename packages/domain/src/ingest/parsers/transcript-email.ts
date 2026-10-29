/** E-mail shaped pieces of a pasted transcript: header blocks, quoted replies and subjects. */

export interface EmailHeaders {
  from: string;
  sent: string | null;
  subject: string | null;
  /** Lines taken by the header block (including the `From:` line). */
  length: number;
}

const HEADER_LINE =
  /^\s*(from|sent|date|to|cc|bcc|subject|reply-to|importance|attachments?)\s*:\s?(.*)$/i;
const MAX_HEADER_LINES = 10;

/**
 * Reads an Outlook- or Gmail-style header block starting at `lines[start]`. A block needs a
 * `From:` line plus at least one of `Sent:`, `Date:` or `Subject:` on consecutive lines, so an
 * ordinary sentence beginning with "From:" is not mistaken for one.
 */
export function readEmailHeaders(lines: readonly string[], start: number): EmailHeaders | null {
  const first = HEADER_LINE.exec((lines[start] ?? '').slice(0, 400));
  if (first?.[1]?.toLowerCase() !== 'from') return null;
  let from = (first[2] ?? '').trim();
  let sent: string | null = null;
  let subject: string | null = null;
  let supporting = 0;
  let index = start + 1;
  while (index < lines.length && index - start < MAX_HEADER_LINES) {
    const match = HEADER_LINE.exec((lines[index] ?? '').slice(0, 400));
    if (!match) break;
    const name = (match[1] ?? '').toLowerCase();
    const value = (match[2] ?? '').trim();
    if (name === 'from') from = from || value;
    else if (name === 'sent' || name === 'date') {
      sent = sent ?? value;
      supporting += 1;
    } else if (name === 'subject') {
      subject = subject ?? value;
      supporting += 1;
    }
    index += 1;
  }
  if (supporting === 0) return null;
  return { from, sent, subject, length: index - start };
}

const REPLY_PREFIX = /^\s*(?:(?:re|fw|fwd|aw|wg|sv|antw)\s*:\s*)+/i;

/** Subject without reply/forward prefixes, lower-cased, for thread matching. */
export function threadKey(subject: string): string {
  return subject.replace(REPLY_PREFIX, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export const isReplySubject = (subject: string): boolean => REPLY_PREFIX.test(subject);

const ATTRIBUTION = /^\s*On\s.{1,300}?\swrote:\s*$/i;
const ATTRIBUTION_START = /^\s*On\s.{1,300}$/i;
const SEPARATOR =
  /^\s*(?:-{2,}\s*(?:original|forwarded)\s+message\s*-{2,}|_{10,}|={10,}|-{10,})\s*$/i;

export const isSeparatorLine = (line: string): boolean => SEPARATOR.test(line.slice(0, 200));

/**
 * Cleans a message body: trailing whitespace and separator lines go, leading blank lines go, and
 * runs of blank lines collapse to one. Indentation inside the message is preserved.
 */
export function tidyBody(lines: readonly string[]): string[] {
  const out = lines.map((line) => line.trimEnd());
  while (out.length > 0) {
    const last = out[out.length - 1] ?? '';
    if (last !== '' && !isSeparatorLine(last)) break;
    out.pop();
  }
  let start = 0;
  while (start < out.length && out[start] === '') start += 1;
  const tidy: string[] = [];
  let blanks = 0;
  for (let i = start; i < out.length; i++) {
    const line = out[i] ?? '';
    blanks = line === '' ? blanks + 1 : 0;
    if (blanks <= 1) tidy.push(line);
  }
  return tidy;
}

export interface QuoteStrip {
  lines: string[];
  removed: number;
}

const isQuote = (line: string | undefined): boolean => /^\s*>/.test(line ?? '');

/**
 * Drops quoted history from one message body. Gmail-style `On <date>, <name> wrote:` lines (also
 * when wrapped onto two lines) are removed together with the `>`-quoted block that follows;
 * un-prefixed text after such a line is treated as pasted history, and later `>` lines (inline
 * replies) are quoted too. Without an attribution, runs of two or more `>` lines are removed; a
 * lone `>` line (often a console prompt) and anything inside a code fence are kept. The message
 * is never emptied: if everything would go, nothing is removed.
 */
export function stripQuotedText(lines: readonly string[]): QuoteStrip {
  const kept: string[] = [];
  let removed = 0;
  let inFence = false;
  let afterAttribution = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const fence = /^\s*```/.test(line);
    if (fence) inFence = !inFence;
    if (inFence || fence) {
      kept.push(line);
      continue;
    }
    const wrapped = ATTRIBUTION_START.test(line) && /^\s*wrote:\s*$/i.test(lines[i + 1] ?? '');
    if (ATTRIBUTION.test(line.slice(0, 400)) || wrapped) {
      let j = i + 1 + (wrapped ? 1 : 0);
      let sawQuote = false;
      while (j < lines.length) {
        const next = lines[j] ?? '';
        if (isQuote(next)) sawQuote = true;
        else if (next.trim().length > 0) break;
        j += 1;
      }
      if (!sawQuote) j = lines.length;
      afterAttribution = true;
      removed += j - i;
      i = j - 1;
      continue;
    }
    if (isQuote(line) && (afterAttribution || isQuote(lines[i + 1]) || isQuote(lines[i - 1]))) {
      removed += 1;
      continue;
    }
    kept.push(line);
  }
  if (kept.every((l) => l.trim().length === 0)) return { lines: [...lines], removed: 0 };
  return { lines: kept, removed };
}
