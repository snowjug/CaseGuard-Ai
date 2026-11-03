import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  NORMALISATION_ENTRIES,
  normaliseChatStyle,
  toOriginalSpan,
} from '../src/engine/normalise-chat';

describe('every entry of the normalisation list', () => {
  for (const [from, to] of NORMALISATION_ENTRIES) {
    it(`${from} -> ${to}`, () => {
      const result = normaliseChatStyle(`so ${from} here, ok`);
      expect(result.text).toBe(`so ${to} here, ok`);
      expect(result.map).not.toBeNull();
    });

    it(`${from} is left alone inside another word, and replaced after a hyphen or a slash (which end a word)`, () => {
      for (const text of [`x${from}y`, `${from}ing`])
        expect(normaliseChatStyle(text).text, text).toBe(text);
      expect(normaliseChatStyle(`a-${from}`).text).toBe(`a-${to}`);
      expect(normaliseChatStyle(`a/${from}`).text).toBe(`a/${to}`);
    });
  }
});

describe('single letters', () => {
  it('replaces a lone lower-case r or u between spaces, and nothing else', () => {
    expect(normaliseChatStyle('colleagues r fine, u know').text).toBe(
      'colleagues are fine, you know',
    );
    for (const text of [
      'R&D is fine',
      'drive R: is full',
      'a u-turn',
      'Plan R',
      'u/me',
      'r2d2',
      'the U.S.',
    ]) {
      expect(normaliseChatStyle(text).text, text).toBe(text);
    }
  });
});

describe('the map back to the stored text', () => {
  const text = 'Gdansk colegues r fine, about 70 ppl cant login';

  it('is absent when nothing was replaced', () => {
    expect(normaliseChatStyle('Everything here is spelled out in full.').map).toBeNull();
  });

  it('turns a span of the normalised text into the span of the words it came from', () => {
    const normalised = normaliseChatStyle(text);
    expect(normalised.text).toBe("Gdansk colleagues are fine, about 70 people can't login");
    const at = (needle: string): { start: number; end: number } => {
      const start = normalised.text.indexOf(needle);
      return toOriginalSpan(normalised.map, start, start + needle.length);
    };
    const original = (needle: string): { start: number; end: number } => {
      const start = text.indexOf(needle);
      return { start, end: start + needle.length };
    };
    expect(at('colleagues are fine')).toEqual(original('colegues r fine'));
    expect(at('70 people')).toEqual(original('70 ppl'));
    expect(at("can't login")).toEqual(original('cant login'));
    expect(at('Gdansk')).toEqual(original('Gdansk'));
  });

  it('never leaves the text, for any text and any span', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.constantFrom(
            'ppl',
            'r',
            'u',
            'pls',
            'dont',
            'the',
            'proxy',
            'agian',
            'x',
            '10.1.2.3',
            '\n',
          ),
          {
            maxLength: 25,
          },
        ),
        fc.nat(200),
        fc.nat(40),
        (words, from, length) => {
          const text = words.join(' ');
          const normalised = normaliseChatStyle(text);
          const start = Math.min(from, normalised.text.length);
          const end = Math.min(normalised.text.length, start + length);
          const span = toOriginalSpan(normalised.map, start, end);
          expect(span.start).toBeGreaterThanOrEqual(0);
          expect(span.end).toBeLessThanOrEqual(text.length);
          if (normalised.map === null) expect(normalised.text).toBe(text);
        },
      ),
      { numRuns: 300 },
    );
  });
});
