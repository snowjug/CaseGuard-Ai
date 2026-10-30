/** Pure keyboard-shortcut matching, shared by the provider and its tests. No DOM beyond reading event fields. */

export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Normalises a key event to a shortcut token: `mod+k` (Ctrl or Cmd), `?`, `/`, `g`, `escape`.
 * Printable characters keep their shifted form (`?` rather than `shift+/`), so tokens match what the person typed.
 */
export function eventToken(event: KeyEventLike): string {
  const key = event.key.toLowerCase();
  if (event.ctrlKey || event.metaKey) return `mod+${key}`;
  if (event.altKey) return `alt+${key}`;
  return key;
}

/** Splits a definition such as `g c` or `mod+k` into tokens. */
export function parseKeys(keys: string): string[] {
  return keys.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * True for a shortcut typed with a letter, digit or symbol on its own (`/`, `?`, `n`, `g c`): the kind WCAG 2.1.4
 * (Character Key Shortcuts) says a person must be able to turn off. A chord with Ctrl, Cmd or Alt (`mod+k`) and a
 * named key (`escape`) are not.
 */
export function isSingleKeyShortcut(keys: string): boolean {
  return parseKeys(keys).some((token) => token.length === 1);
}

export type SequenceMatch = 'none' | 'prefix' | 'exact';

/** Compares what was typed so far with a shortcut definition. */
export function matchSequence(
  typed: readonly string[],
  definition: readonly string[],
): SequenceMatch {
  if (typed.length === 0 || typed.length > definition.length) return 'none';
  for (let i = 0; i < typed.length; i++) if (typed[i] !== definition[i]) return 'none';
  return typed.length === definition.length ? 'exact' : 'prefix';
}

/** True for elements where typing must not trigger shortcuts. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return ![
      'button',
      'checkbox',
      'radio',
      'submit',
      'reset',
      'range',
      'file',
      'image',
      'color',
    ].includes(type);
  }
  return target.getAttribute('role') === 'textbox' || target.getAttribute('role') === 'combobox';
}

/** Human display of a definition: `g c` becomes `G then C`, `mod+k` becomes `Ctrl+K` (`⌘K` on macOS). */
export function formatKeys(keys: string, isMac = false): string {
  const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
  return parseKeys(keys)
    .map((token) => {
      const parts = token.split('+');
      const key = parts.pop() ?? '';
      const modifiers = parts.map((part) =>
        part === 'mod'
          ? isMac
            ? '⌘'
            : 'Ctrl'
          : part === 'alt'
            ? isMac
              ? '⌥'
              : 'Alt'
            : capitalise(part),
      );
      const shown = key.length === 1 ? key.toUpperCase() : capitalise(key);
      return [...modifiers, shown].join(isMac ? '' : '+');
    })
    .join(' then ');
}
