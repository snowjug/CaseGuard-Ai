import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { session } from '../../../test/fixtures';
import { expectNoAxeViolations, fakeApi, renderApp } from '../../../test/harness';
import { TruncatedText, truncateAtWord } from './TruncatedText';

const EMOJI = '\u{1F600}';

describe('truncateAtWord', () => {
  it('returns text that already fits', () => {
    expect(truncateAtWord('short text', 40)).toBe('short text');
    expect(truncateAtWord('exactly ten', 11)).toBe('exactly ten');
  });

  it('cuts at the last word boundary and adds an ellipsis', () => {
    expect(truncateAtWord('The resolver answers slowly for branch sites', 30)).toBe(
      'The resolver answers slowly…',
    );
  });

  it('cuts inside a long word when there is no boundary to use', () => {
    expect(truncateAtWord('abcdefghijklmnopqrstuvwxyz', 10)).toBe('abcdefghij…');
  });

  it('never leaves half of a surrogate pair at the cut', () => {
    // Each emoji is two UTF-16 units; the first one occupies units 8 and 9 of the text.
    const text = `0123456x${EMOJI}${EMOJI}${EMOJI}${EMOJI}`;
    for (let limit = 5; limit <= 14; limit += 1) {
      const cut = truncateAtWord(text, limit);
      const kept = cut.slice(0, -1);
      expect(cut.endsWith('…')).toBe(true);
      expect(kept.length).toBeLessThanOrEqual(limit);
      // encodeURIComponent throws a URIError for a lone surrogate.
      expect(() => encodeURIComponent(kept)).not.toThrow();
      expect(kept).not.toContain('\uFFFD');
    }
    // A cut after unit 9 would keep only the first half of the emoji: the whole emoji is dropped instead.
    expect(truncateAtWord(text, 9)).toBe('0123456x…');
    expect(truncateAtWord(text, 10)).toBe(`0123456x${EMOJI}…`);
  });
});

describe('TruncatedText', () => {
  it('shows a whole emoji or none at the cut, and the full text after Show more', async () => {
    const user = userEvent.setup();
    // Fifty characters of words, then an emoji whose first half would sit exactly at the cut.
    const text = `${'word '.repeat(10)}${EMOJI}${EMOJI} and the rest of the sentence`;
    const { container } = renderApp(<TruncatedText text={text} limit={51} />, {
      api: fakeApi({ 'session.me': () => session('engineer', ['case:read']) }),
    });
    const shown = (): string =>
      screen.getByText((content) => content.startsWith('word word')).textContent ?? '';

    expect(shown().endsWith('…')).toBe(true);
    expect(shown()).not.toContain('\uFFFD');
    expect(() => encodeURIComponent(shown())).not.toThrow();
    await expectNoAxeViolations(container);

    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(shown()).toBe(text);
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});
