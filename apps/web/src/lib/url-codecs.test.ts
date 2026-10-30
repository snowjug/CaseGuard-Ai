import { describe, expect, it } from 'vitest';
import { boundedString } from './url-codecs';

const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

describe('boundedString', () => {
  it('bounds free text the way the API counts it, and leaves short text alone', () => {
    const codec = boundedString(5);
    expect(codec.parse('abcdefgh')).toBe('abcde');
    expect(codec.serialize('abcdefgh')).toBe('abcde');
    expect(codec.parse('abc')).toBe('abc');
    expect(codec.serialize('abc')).toBe('abc');
    expect(codec.parse(null)).toBe('');
    expect(codec.serialize('')).toBeNull();
  });

  it('never cuts an emoji in half, in the URL or in the value read from it', () => {
    const codec = boundedString(200);
    const text = `${'a'.repeat(199)}😀 and more words`;
    const parsed = codec.parse(text);
    const serialized = codec.serialize(text) ?? '';
    expect(parsed).toBe('a'.repeat(199));
    expect(serialized).toBe('a'.repeat(199));
    expect(loneSurrogate.test(parsed)).toBe(false);
    expect(loneSurrogate.test(serialized)).toBe(false);
    // An emoji that fits whole is kept.
    expect(codec.parse(`${'b'.repeat(198)}😀tail`)).toBe(`${'b'.repeat(198)}😀`);
    expect(codec.serialize(`${'b'.repeat(198)}😀tail`)).toBe(`${'b'.repeat(198)}😀`);
  });
});
