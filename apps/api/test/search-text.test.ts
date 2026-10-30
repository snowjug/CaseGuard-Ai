import { describe, expect, it } from 'vitest';
import { cleanText, plainText, stripMarkup } from '../src/services/search';

describe('[NFR-SEC-04] plain text of index documents (pure)', () => {
  it('leaves text without markup exactly as it is', () => {
    for (const text of [
      'Sign-in outage',
      'a < b and c > d',
      '1<2',
      'I <3 this',
      'price > 5',
      '< b',
      '日本語 😀 <',
      '<',
      '',
    ]) {
      expect(stripMarkup(text)).toBe(text);
    }
  });

  it('removes tags and keeps the words around them apart', () => {
    expect(plainText('<b>Resolver</b> timeout')).toBe('Resolver timeout');
    expect(plainText('first<br>second')).toBe('first second');
    expect(plainText('<a href="https://x.test/?a=1&b=2" onclick="evil()">link</a>')).toBe('link');
    expect(plainText('<IMG SRC=x onerror=alert(1)>caption')).toBe('caption');
    expect(plainText('<scripty>an ordinary tag</scripty>')).toBe('an ordinary tag');
  });

  it('leaves no gap for an inline tag and a space for a block or a line break', () => {
    expect(plainText('Click <b>Save</b>.')).toBe('Click Save.');
    expect(plainText('<b>Re</b>solver')).toBe('Resolver');
    expect(plainText('see <a href="x">the docs</a>, then <code>retry</code>')).toBe(
      'see the docs, then retry',
    );
    expect(plainText('one<p>two</p>three')).toBe('one two three');
    expect(plainText('<ul><li>one</li><li>two</li></ul>')).toBe('one two');
  });

  it('cannot be made to rebuild a tag from what is left around removed tags', () => {
    expect(plainText('<<i>b>')).toBe('< b>');
    for (const text of [
      '<<i>script>alert(1)<<i>/script>',
      '<<b>img src=x onerror=alert(1)>',
      '<<span>!-- x -->',
      '<<i><i>b>',
      '<<a></a>/b>',
      '<<em><em>?xml?>',
    ]) {
      const once = plainText(text);
      expect(once, text).not.toMatch(/<[A-Za-z/!?]/);
      expect(plainText(once)).toBe(once);
    }
  });

  it('removes scripts and styles together with their content, in any letter case', () => {
    expect(plainText('<script>alert(1)</script>Resolver')).toBe('Resolver');
    expect(plainText('a<SCRIPT type="text/javascript">var x = "</p>";</SCRIPT >b')).toBe('a b');
    expect(plainText('a<style>.x { color: red }</style>b')).toBe('a b');
    expect(plainText('a<script>never closed')).toBe('a');
    expect(plainText('a<script src=x>one</script>b<script>two</script>c')).toBe('a b c');
  });

  it('removes comments, declarations and instructions', () => {
    expect(plainText('a<!-- hidden > still hidden -->b')).toBe('a b');
    expect(plainText('<!DOCTYPE html>text')).toBe('text');
    expect(plainText('<?xml version="1.0"?>text')).toBe('text');
    expect(plainText('a<!-- never closed')).toBe('a');
  });

  it('removes markup that never closes, so a fragment cannot join the text of whoever shows it', () => {
    expect(plainText('caption <img src=x onerror=alert(1)')).toBe('caption');
    expect(plainText('a <b')).toBe('a');
  });

  it('does not decode entities: they stay visible text', () => {
    expect(plainText('&lt;script&gt;alert(1)&lt;/script&gt; &amp; more')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt; &amp; more',
    );
  });

  it('drops control characters and collapses blanks', () => {
    expect(cleanText(' a\t\tb\u0000c\n\nd ')).toBe('a b c d');
    expect(plainText('  <p>one</p>\n<p>two</p>  ')).toBe('one two');
  });

  it('is idempotent and leaves no tag behind', () => {
    for (const text of [
      '<b>Resolver</b> timeout',
      '<<b>>nested<</b>>',
      '<a<b>c>',
      '<scr<script>x</script>ipt>alert(1)</script>',
      'x<!--<script>-->y',
      '<svg/onload=alert(1)>',
      '</p></div>tail',
      'plain',
    ]) {
      const once = plainText(text);
      expect(plainText(once)).toBe(once);
      expect(once).not.toMatch(/<[A-Za-z/!?]/);
    }
  });

  it('is linear: input built to make a pattern backtrack is handled at once', () => {
    const size = 300_000;
    const hostile = [
      '<a'.repeat(size),
      '<script'.repeat(size / 4),
      '<script>'.repeat(size / 4),
      `<script>${'</'.repeat(size)}`,
      '<!--'.repeat(size),
      '</'.repeat(size),
      '<'.repeat(size),
      '<a>'.repeat(size / 3),
      '<<i>'.repeat(size / 4),
      '<<i></i>'.repeat(size / 8),
      `<${' '.repeat(size)}`,
      `${'<a '.repeat(size / 3)}>`,
    ];
    for (const text of hostile) {
      expect(plainText(text).length).toBeLessThanOrEqual(text.length);
    }
  });
});
