/*
 * Documents of an external index are text this API did not write, and they are shown as plain text.
 * Markup is removed rather than trusted, so whoever renders a result (the web app escapes text, but a
 * chat bot or an export might not) never receives a tag. The scan is linear in the length of the text:
 * untrusted input must not be able to make a pattern backtrack.
 */

/** What follows a "<" when it opens markup: a tag name, a closing tag, a declaration or an instruction. */
const MARKUP_START = /[A-Za-z/!?]/;
/** Elements whose content is code or styling, not text for a reader. */
const RAW_TEXT_ELEMENT = /^<(script|style)(?=[\s/>]|$)/i;
const TAG_NAME = /^<\/?([A-Za-z][A-Za-z0-9-]*)/;
/** Elements that sit inside a line of text: removing their tags leaves no gap ("Save</b>." stays "Save."). */
const INLINE_ELEMENTS: ReadonlySet<string> = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'cite',
  'code',
  'data',
  'del',
  'dfn',
  'em',
  'font',
  'i',
  'ins',
  'kbd',
  'mark',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'time',
  'tt',
  'u',
  'var',
  'wbr',
]);

/** Index just after the closing tag of `name` (or the end of the text when it never closes). */
function endOfRawText(text: string, name: string, from: number): number {
  let at = text.indexOf('</', from);
  while (at !== -1) {
    const nameEnd = at + 2 + name.length;
    if (text.slice(at + 2, nameEnd).toLowerCase() === name) {
      const close = text.indexOf('>', nameEnd);
      return close === -1 ? text.length : close + 1;
    }
    at = text.indexOf('</', at + 2);
  }
  return text.length;
}

/** Index just after the markup that starts at `start` (a "<"). Markup that never closes runs to the end. */
function endOfMarkup(text: string, start: number): number {
  if (text.startsWith('<!--', start)) {
    const close = text.indexOf('-->', start + 4);
    return close === -1 ? text.length : close + 3;
  }
  const close = text.indexOf('>', start + 1);
  if (close === -1) return text.length;
  const element = RAW_TEXT_ELEMENT.exec(text.slice(start, start + 8));
  // A script or style element goes with its content: that is code, not words.
  return element === null
    ? close + 1
    : endOfRawText(text, (element[1] ?? '').toLowerCase(), close + 1);
}

/** What a removed piece of markup leaves behind: nothing inside a line, a space between blocks and words. */
function separatorFor(text: string, start: number): string {
  const name = TAG_NAME.exec(text.slice(start, start + 24))?.[1]?.toLowerCase();
  return name !== undefined && INLINE_ELEMENTS.has(name) ? '' : ' ';
}

/**
 * The text without tags, comments, declarations, scripts and styles. A "<" that does not open markup
 * ("a < b", "1<2") is text and stays. A removed block-level tag, line break, script or comment leaves a
 * space so neighbouring words do not run together; an inline tag (bold, link, span) leaves nothing.
 */
export function stripMarkup(text: string): string {
  let result = '';
  // Whether `result` ends with a "<" that stayed text: joining it to what follows a removed tag must
  // not form a new tag ("<" + "<i>" + "b>" would otherwise leave "<b>").
  let endsWithOpen = false;
  let position = 0;
  while (position < text.length) {
    const start = text.indexOf('<', position);
    if (start === -1) return result + text.slice(position);
    if (start > position) {
      result += text.slice(position, start);
      endsWithOpen = false;
    }
    if (MARKUP_START.test(text.charAt(start + 1))) {
      const separator = endsWithOpen ? ' ' : separatorFor(text, start);
      result += separator;
      if (separator !== '') endsWithOpen = false;
      position = endOfMarkup(text, start);
    } else {
      result += '<';
      endsWithOpen = true;
      position = start + 1;
    }
  }
  return result;
}

/** Control characters become blanks and runs of blanks collapse into one space. */
export function cleanText(value: string): string {
  return value
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** What an index document may show: no markup, no control characters, no blank runs. */
export function plainText(value: string): string {
  return cleanText(stripMarkup(value));
}
