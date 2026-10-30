import { describe, expect, it } from 'vitest';
import { clipText } from './text';

const EMOJI = '\u{1F600}';

describe('clipText', () => {
  it('returns text that already fits, and an empty string for a non-positive limit', () => {
    expect(clipText('abc', 3)).toBe('abc');
    expect(clipText('abc', 10)).toBe('abc');
    expect(clipText('abc', 0)).toBe('');
    expect(clipText('abc', -1)).toBe('');
  });

  it('cuts plain text at the limit', () => {
    expect(clipText('abcdef', 4)).toBe('abcd');
  });

  it('never leaves half of a surrogate pair at the cut', () => {
    const text = `ab${EMOJI}cd`;
    // The emoji occupies units 2 and 3: a cut after unit 3 (limit 3) would keep only its first half.
    expect(clipText(text, 3)).toBe('ab');
    expect(clipText(text, 4)).toBe(`ab${EMOJI}`);
    expect(clipText(text, 5)).toBe(`ab${EMOJI}c`);
  });

  it('never exceeds the limit, which is how the API counts its limits', () => {
    for (const limit of [1, 2, 3, 4, 5, 6, 7]) {
      const clipped = clipText(`${EMOJI}${EMOJI}${EMOJI}${EMOJI}`, limit);
      expect(clipped.length).toBeLessThanOrEqual(limit);
      // encodeURIComponent throws a URIError for a lone surrogate.
      expect(() => encodeURIComponent(clipped)).not.toThrow();
    }
  });
});
