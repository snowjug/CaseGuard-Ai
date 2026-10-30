/** Pure helpers for the governance forms: dotted-path access, deep equality and readable validation messages. */

/** The value at a dotted path (`agentBudgets.quality_judge.maxInputTokens`; array items by index). */
export function getIn(root: unknown, path: string): unknown {
  let node: unknown = root;
  for (const key of path.split('.')) {
    if (node === null || node === undefined) return undefined;
    if (Array.isArray(node)) node = node[Number(key)];
    else if (typeof node === 'object') node = (node as Record<string, unknown>)[key];
    else return undefined;
  }
  return node;
}

/** A copy of `root` with the value at `path` replaced; nothing is mutated, untouched branches are shared. */
export function setIn<T>(root: T, path: string, value: unknown): T {
  const keys = path.split('.');
  const apply = (node: unknown, index: number): unknown => {
    const key = keys[index];
    if (key === undefined) return value;
    if (Array.isArray(node)) {
      const copy = node.slice() as unknown[];
      const position = Number(key);
      copy[position] = apply(copy[position], index + 1);
      return copy;
    }
    const record = (typeof node === 'object' && node !== null ? node : {}) as Record<
      string,
      unknown
    >;
    return { ...record, [key]: apply(record[key], index + 1) };
  };
  return apply(root, 0) as T;
}

/** Structural equality for JSON-like values (what the API returns and the forms edit). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]))
  );
}

/** Key under which problems with the change note (not with a setting) are stored. */
export const NOTE_KEY = '#changeNote';
/** Key for a problem with the whole value (no field path). */
export const WHOLE_KEY = '#value';

/** `text` ended with a full stop, so two messages can be joined into readable sentences. */
export function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Turns the standard Zod sentences (the same ones the API sends in its 422 problems) into short instructions a person
 * can act on. Anything it does not recognise is returned unchanged, so no information is lost.
 */
export function friendlyMessage(message: string): string {
  const minimum = /^Too small: expected number to be >=\s*(.+)$/.exec(message);
  if (minimum) return `Enter ${minimum[1]} or more.`;
  const exclusiveMinimum = /^Too small: expected number to be >\s*(.+)$/.exec(message);
  if (exclusiveMinimum) return `Enter more than ${exclusiveMinimum[1]}.`;
  const maximum = /^Too big: expected number to be <=\s*(.+)$/.exec(message);
  if (maximum) return `Enter ${maximum[1]} or less.`;
  if (/^Invalid input: expected number, received/.test(message)) return 'Enter a number.';
  if (/expected int\b/.test(message)) return 'Enter a whole number.';
  const shortText = /^Too small: expected string to have >=\s*(\d+) characters?$/.exec(message);
  if (shortText)
    return `Enter at least ${shortText[1]} character${shortText[1] === '1' ? '' : 's'}.`;
  const longText = /^Too big: expected string to have <=\s*(\d+) characters?$/.exec(message);
  if (longText) return `Use at most ${longText[1]} characters.`;
  const manyItems = /^Too big: expected array to have <=\s*(\d+) items?$/.exec(message);
  if (manyItems) return `At most ${manyItems[1]} items are allowed.`;
  const fewItems = /^Too small: expected array to have >=\s*(\d+) items?$/.exec(message);
  if (fewItems)
    return `At least ${fewItems[1]} item${fewItems[1] === '1' ? ' is' : 's are'} required.`;
  return message;
}

interface IssueLike {
  readonly path: readonly PropertyKey[] | string;
  readonly message: string;
}

const BODY_VALUE = /^body\.value\.?/;

/**
 * Field problems keyed by dotted path. Client-side Zod issues carry a path array; the API's 422 problems carry
 * `body.value.<path>` (a problem with the change note is `body.changeNote`). The first message for a path wins.
 */
export function issuesToErrors(issues: readonly IssueLike[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    let key: string;
    if (typeof issue.path === 'string') {
      if (issue.path === 'body.changeNote') key = NOTE_KEY;
      else if (BODY_VALUE.test(issue.path)) key = issue.path.replace(BODY_VALUE, '') || WHOLE_KEY;
      else key = issue.path || WHOLE_KEY;
    } else {
      key = issue.path.map(String).join('.') || WHOLE_KEY;
    }
    if (!(key in errors)) errors[key] = friendlyMessage(issue.message);
  }
  return errors;
}
