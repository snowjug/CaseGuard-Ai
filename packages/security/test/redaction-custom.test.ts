import { describe, expect, it } from 'vitest';
import { compileCustomPatterns, describeBacktrackingRisk } from '../src/redaction/custom';
import { redactText } from '../src/redaction/redact-text';
import { secrets } from './helpers/secrets';

const patterns = (...specs: [name: string, pattern: string][]) =>
  specs.map(([name, pattern]) => ({ name, pattern }));

describe('custom redaction patterns (admin supplied)', { timeout: 60_000 }, () => {
  it('redacts matches with the custom placeholder and reports a custom finding', () => {
    const result = redactText('Tickets CUST-123456 and CUST-654321, not CUST-12', {
      customPatterns: patterns(['customer id', 'CUST-\\d{6}']),
    });
    expect(result.text).toBe('Tickets [REDACTED:custom] and [REDACTED:custom], not CUST-12');
    expect(result.findings).toEqual([
      { category: 'custom', count: 2, placeholder: '[REDACTED:custom]' },
    ]);
    expect(result.notes).toEqual([]);
  });

  it('runs even when the custom category is not toggled on, so a forgotten switch cannot disable it', () => {
    const result = redactText('ACME-0042', {
      enabledCategories: ['email_address'],
      customPatterns: patterns(['acme', 'ACME-\\d{4}']),
    });
    expect(result.text).toBe('[REDACTED:custom]');
  });

  it('runs after the built-in categories and never rewrites their placeholders', () => {
    const text = `Bearer ${secrets.bearerToken()} from a@customer.io`;
    const result = redactText(text, {
      customPatterns: patterns(
        ['everything redacted', 'REDACTED'],
        ['pseudonym', 'email_address#\\d'],
        ['bracket', '\\[[^\\]]+\\]'],
      ),
    });
    expect(result.text).toBe('Bearer [REDACTED:bearer_token] from [REDACTED:email_address#1]');
    expect(result.findings.map((f) => f.category)).toEqual(['bearer_token', 'email_address']);
  });

  it('lets custom patterns match text that sits next to placeholders', () => {
    const result = redactText('a@customer.io ACME-1', {
      customPatterns: patterns(['acme', 'ACME-\\d']),
    });
    expect(result.text).toBe('[REDACTED:email_address#1] [REDACTED:custom]');
  });

  it('applies several patterns in order and counts each match', () => {
    const result = redactText('A-1 B-2 A-3', {
      customPatterns: patterns(['a', 'A-\\d'], ['b', 'B-\\d']),
    });
    expect(result.text).toBe('[REDACTED:custom] [REDACTED:custom] [REDACTED:custom]');
    expect(result.findings[0]?.count).toBe(3);
  });

  it('skips invalid regular expressions with a note instead of throwing', () => {
    const result = redactText('ACME-0042 (', {
      customPatterns: patterns(['broken', '('], ['also broken', '[a-'], ['fine', 'ACME-\\d{4}']),
    });
    expect(result.text).toBe('[REDACTED:custom] (');
    expect(result.notes).toEqual([
      'Custom redaction pattern "broken" was skipped: it is not a valid regular expression',
      'Custom redaction pattern "also broken" was skipped: it is not a valid regular expression',
    ]);
  });

  it('skips empty and over-long patterns', () => {
    const result = redactText('x', {
      customPatterns: patterns(['empty', ''], ['long', 'a'.repeat(201)], ['edge', 'z'.repeat(200)]),
    });
    expect(result.notes).toEqual([
      'Custom redaction pattern "empty" was skipped: the pattern is empty',
      'Custom redaction pattern "long" was skipped: the pattern is longer than 200 characters',
    ]);
  });

  it('skips patterns that can match the empty string (they would redact between every character)', () => {
    const result = redactText('abc', {
      customPatterns: patterns(['star', 'a*'], ['optional', '(?:x)?']),
    });
    expect(result.text).toBe('abc');
    expect(result.notes).toHaveLength(2);
    expect(result.notes[0]).toContain('can match an empty string');
  });

  it('skips back-references and look-around assertions', () => {
    const result = redactText('aa', {
      customPatterns: patterns(
        ['backref', '(a)\\1'],
        ['lookahead', 'a(?=a)'],
        ['lookbehind', '(?<=a)a'],
      ),
    });
    expect(result.text).toBe('aa');
    expect(result.notes[0]).toContain('back-reference');
    expect(result.notes[1]).toContain('look-around');
    expect(result.notes[2]).toContain('look-around');
  });

  it('[NFR-SEC-05] rejects catastrophic-backtracking patterns up front without hanging', () => {
    const dangerous = ['(a+)+$', '(a|aa)+$', '(a*)*b', '([a-z]+)*x', '(.*a){12}x', '(\\d+\\.?)+$'];
    const started = performance.now();
    const result = redactText('a'.repeat(5000) + '!', {
      customPatterns: patterns(...dangerous.map((p, i): [string, string] => [`p${i}`, p])),
    });
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(result.totalReplacements).toBe(0);
    expect(result.notes).toHaveLength(dangerous.length);
    for (const note of result.notes) expect(note).toContain('catastrophic backtracking');
  });

  it('[NFR-SEC-05] rejects patterns that only reveal themselves as too slow when probed', () => {
    // Three overlapping unbounded quantifiers pass the static check but are cubic on a 2000-char run.
    const started = performance.now();
    const result = redactText('ok', { customPatterns: patterns(['cubic', '\\w+\\w+\\w+x']) });
    expect(performance.now() - started).toBeLessThan(30_000);
    expect(result.notes).toEqual([
      'Custom redaction pattern "cubic" was skipped: it exceeded the evaluation time budget on adversarial input',
    ]);
  });

  it('[NFR-SEC-05] cuts off a pattern that is slow on a particular input, reports it and keeps redacting', () => {
    const options = { customPatterns: patterns(['quadratic', '\\w+x']) };
    // Safe-looking (one unbounded quantifier) but O(n^2) on a long run with no match.
    const hostile = `${'a'.repeat(400_000)} reach me at help@customer.io`;
    const started = performance.now();
    const first = redactText(hostile, options);
    // A quadratic scan of 400k characters would run for minutes; the budget cuts it off.
    expect(performance.now() - started).toBeLessThan(30_000);
    expect(first.text.endsWith('reach me at [REDACTED:email_address#1]')).toBe(true);
    expect(first.notes.join('\n')).toContain('exceeded the evaluation time budget on this input');

    // The pattern is now disabled for this configuration: still reported, no longer applied.
    const second = redactText('plain text with x', options);
    expect(second.text).toBe('plain text with x');
    expect(second.notes.join('\n')).toContain('disabled');
  });

  it('recompiles when the pattern list changes even if the array identity is reused', () => {
    const list = patterns(['first', 'AAA\\d']);
    expect(redactText('AAA1 BBB2', { customPatterns: list }).text).toBe('[REDACTED:custom] BBB2');
    (list as unknown as { name: string; pattern: string }[])[0] = {
      name: 'second',
      pattern: 'BBB\\d',
    };
    expect(redactText('AAA1 BBB2', { customPatterns: list }).text).toBe('AAA1 [REDACTED:custom]');
  });

  it('applies at most 20 patterns', () => {
    const many = patterns(
      ...Array.from({ length: 21 }, (_, i): [string, string] => [`p${i}`, `T${i}X`]),
    );
    const result = redactText('T20X T0X', { customPatterns: many });
    expect(result.text).toBe('T20X [REDACTED:custom]');
    expect(result.notes).toContain('Only the first 20 custom redaction patterns are applied');
  });

  it('copes with hostile names and malformed specs', () => {
    const result = redactText('ok', {
      customPatterns: [
        { name: 'bad\u0000name\u202E' + 'x'.repeat(100), pattern: '(' },
        { name: 42 as unknown as string, pattern: 7 as unknown as string },
      ],
    });
    expect(result.text).toBe('ok');
    expect(result.notes[0]).toBe(
      `Custom redaction pattern "badname${'x'.repeat(53)}" was skipped: it is not a valid regular expression`,
    );
    expect(result.notes[1]).toBe(
      'Custom redaction pattern "pattern 2" was skipped: the pattern is empty',
    );
  });

  it('exposes compileCustomPatterns for settings validation (never throws)', () => {
    const compiled = compileCustomPatterns(patterns(['good', 'ID-\\d+'], ['bad', '(']));
    expect(compiled.entries.map((entry) => entry.name)).toEqual(['good']);
    expect(compiled.notes).toHaveLength(1);
  });
});

describe('describeBacktrackingRisk', () => {
  it.each([
    'CUST-\\d{6}',
    '[A-Z]{3}-\\d+',
    '\\b\\w{8,32}\\b',
    '(?:ab)?c+',
    'a{2,5}b*',
    'foo|bar',
    '(?:Mr|Mrs) \\w+',
    '(abc)+',
    '(?<id>\\d{4})-(?<ref>[A-Z]{2})',
    '[a-z+*(]+@[a-z]+',
    '\\(\\d+\\)',
    '\\d{3}-\\d{4}',
  ])('accepts %s', (pattern) => {
    expect(describeBacktrackingRisk(pattern)).toBeNull();
  });

  it.each([
    ['(a+)+', 'repeats a group'],
    ['(a*)*', 'repeats a group'],
    ['(a|b)+', 'repeats a group'],
    ['(a|ab)*c', 'repeats a group'],
    ['((a+)b)+', 'repeats a group'],
    ['(.*a){5}', 'repeats a group'],
    ['(\\d+\\.?)+', 'repeats a group'],
    ['(a)\\1', 'back-reference'],
    ['(?<x>a)\\k<x>', 'back-reference'],
    ['(?=a)', 'look-around'],
    ['(?!a)b', 'look-around'],
    ['(?<=a)b', 'look-around'],
    ['(?<!a)b', 'look-around'],
    ['a+b+c+d+e+f', 'too many unbounded'],
  ])('flags %s', (pattern, reason) => {
    expect(describeBacktrackingRisk(pattern)).toContain(reason);
  });
});
