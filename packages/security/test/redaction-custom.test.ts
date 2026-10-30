import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RedactionIncompleteError, assertRedactionComplete } from '../src/errors';
import {
  DEFAULT_PATTERN_DEPS,
  MAX_MATCHES_PER_PATTERN,
  MAX_MATCHES_PER_STRING,
  compileCustomPatterns,
  createCustomPatternBudget,
  customPatternCacheSize,
  describeBacktrackingRisk,
  resetCustomPatternCache,
  runInSandbox,
  type PatternDeps,
  type PatternRunner,
} from '../src/redaction/custom';
import { createPseudonymState } from '../src/redaction/pseudonyms';
import { redactText, redactTexts, redactTextsWith } from '../src/redaction/redact-text';
import { redactValues } from '../src/redaction/redact-value';

const patterns = (...specs: [name: string, pattern: string][]) =>
  specs.map(([name, pattern]) => ({ name, pattern }));

const NBSP = '\u00a0';
const ZWSP = '\u200b';

/** Wraps a runner so a test can see how many sandbox evaluations were made and over how many strings. */
function counting(inner: PatternRunner = runInSandbox) {
  const calls: { strings: number; deadlineMs: number }[] = [];
  const runner: PatternRunner = (regex, texts, limits, deadlineMs) => {
    calls.push({ strings: texts.length, deadlineMs });
    return inner(regex, texts, limits, deadlineMs);
  };
  return { runner, calls };
}

const withRunner = (runner: PatternRunner, extra: Partial<PatternDeps> = {}): PatternDeps => ({
  ...DEFAULT_PATTERN_DEPS,
  runner,
  ...extra,
});

const NO_MATCHES: PatternRunner = () => ({ kind: 'ok', spans: [] });

/** `redactTexts` with injected sandbox dependencies (a fake runner, clock or limits). */
const redactWith = (
  values: readonly string[],
  options: Parameters<typeof redactTexts>[1],
  deps: PatternDeps,
) => redactTextsWith(values, options ?? {}, createPseudonymState(), { patternDeps: deps });

beforeEach(() => {
  resetCustomPatternCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

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
    expect(result.complete).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('runs even when the custom category is not toggled on, so a forgotten switch cannot disable it', () => {
    const result = redactText('ACME-0042', {
      enabledCategories: ['email_address'],
      customPatterns: patterns(['acme', 'ACME-\\d{4}']),
    });
    expect(result.text).toBe('[REDACTED:custom]');
  });

  it('runs after the built-in categories and never rewrites their placeholders', () => {
    const text = 'Authorization: Bearer abcdefghijklmnop1234567890 from a@customer.io';
    const result = redactText(text, {
      customPatterns: patterns(
        ['everything redacted', 'REDACTED'],
        ['pseudonym', 'email_address#\\d'],
        ['bracket', '\\[[^\\]]+\\]'],
      ),
    });
    expect(result.text).toBe(
      'Authorization: Bearer [REDACTED:bearer_token] from [REDACTED:email_address#1]',
    );
    expect(result.findings.map((f) => f.category)).toEqual(['bearer_token', 'email_address']);
  });

  it('lets custom patterns match text that sits next to placeholders', () => {
    const result = redactText('a@customer.io ACME-1', {
      customPatterns: patterns(['acme', 'ACME-\\d']),
    });
    expect(result.text).toBe('[REDACTED:email_address#1] [REDACTED:custom]');
  });

  it('applies several patterns and counts each match', () => {
    const result = redactText('A-1 B-2 A-3', {
      customPatterns: patterns(['a', 'A-\\d'], ['b', 'B-\\d']),
    });
    expect(result.text).toBe('[REDACTED:custom] [REDACTED:custom] [REDACTED:custom]');
    expect(result.findings[0]?.count).toBe(3);
  });

  it('redacts everything two patterns match, however they overlap, and in any order', () => {
    const first = patterns(['one', 'abc'], ['two', 'bcd']);
    const reversed = [...first].reverse();
    expect(redactText('x abcd x', { customPatterns: first }).text).toBe('x [REDACTED:custom] x');
    expect(redactText('x abcd x', { customPatterns: reversed }).text).toBe('x [REDACTED:custom] x');
    // Matches that merely touch stay separate placeholders.
    expect(
      redactText('ACME-1ACME-2', { customPatterns: patterns(['a', 'ACME-\\d']) }).findings[0]
        ?.count,
    ).toBe(2);
  });

  it('looks through the same Unicode tricks as the built-in rules', () => {
    const options = { customPatterns: patterns(['acct', 'ACME-\\d{4}'], ['phrase', 'my secret']) };
    expect(redactText('id ACME-\uff11\uff12\uff13\uff14 ok', options).text).toBe(
      'id [REDACTED:custom] ok',
    );
    expect(redactText(`say my${NBSP}secret now`, options).text).toBe('say [REDACTED:custom] now');
    expect(redactText(`AC${ZWSP}ME-1234${ZWSP}!`, options).text).toBe(`[REDACTED:custom]${ZWSP}!`);
  });

  describe('a pattern that cannot run is reported, never skipped silently (H2)', () => {
    it('reports invalid regular expressions as typed failures and still applies the others', () => {
      const result = redactText('ACME-0042 (', {
        customPatterns: patterns(['broken', '('], ['also broken', '[a-'], ['fine', 'ACME-\\d{4}']),
      });
      expect(result.text).toBe('[REDACTED:custom] (');
      expect(result.notes).toEqual([
        'Custom redaction pattern "broken" was skipped: it is not a valid regular expression',
        'Custom redaction pattern "also broken" was skipped: it is not a valid regular expression',
      ]);
      expect(result.complete).toBe(false);
      expect(result.failures).toEqual([
        {
          code: 'invalid',
          index: 0,
          label: 'broken',
          message: 'it is not a valid regular expression',
        },
        {
          code: 'invalid',
          index: 1,
          label: 'also broken',
          message: 'it is not a valid regular expression',
        },
      ]);
    });

    it('reports empty and over-long patterns', () => {
      const result = redactText('x', {
        customPatterns: patterns(
          ['empty', ''],
          ['long', 'a'.repeat(201)],
          ['edge', 'z'.repeat(200)],
        ),
      });
      expect(result.notes).toEqual([
        'Custom redaction pattern "empty" was skipped: the pattern is empty',
        'Custom redaction pattern "long" was skipped: the pattern is longer than 200 characters',
      ]);
      expect(result.failures.map((item) => [item.code, item.index])).toEqual([
        ['invalid', 0],
        ['invalid', 1],
      ]);
    });

    it('reports patterns that can match the empty string (they would redact between every character)', () => {
      const result = redactText('abc', {
        customPatterns: patterns(['star', 'a*'], ['optional', '(?:x)?']),
      });
      expect(result.text).toBe('abc');
      expect(result.notes).toHaveLength(2);
      expect(result.notes[0]).toContain('can match an empty string');
      expect(result.complete).toBe(false);
    });

    it('reports back-references and look-around assertions', () => {
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
      expect(result.failures.every((item) => item.code === 'unsafe')).toBe(true);
    });

    it('[NFR-SEC-05] rejects catastrophic-backtracking patterns up front without hanging', () => {
      const dangerous = [
        '(a+)+$',
        '(a|aa)+$',
        '(a*)*b',
        '([a-z]+)*x',
        '(.*a){12}x',
        '(\\d+\\.?)+$',
      ];
      const started = performance.now();
      const result = redactText('a'.repeat(5000) + '!', {
        customPatterns: patterns(...dangerous.map((p, i): [string, string] => [`p${i}`, p])),
      });
      expect(performance.now() - started).toBeLessThan(15_000);
      expect(result.totalReplacements).toBe(0);
      expect(result.notes).toHaveLength(dangerous.length);
      for (const note of result.notes) expect(note).toContain('catastrophic backtracking');
      expect(result.failures.every((item) => item.code === 'unsafe')).toBe(true);
    });

    it('[NFR-SEC-05] rejects patterns that only reveal themselves as too slow when probed', () => {
      // Three overlapping unbounded quantifiers pass the static check but are cubic on a 2000-char run.
      const started = performance.now();
      const result = redactText('ok', { customPatterns: patterns(['cubic', '\\w+\\w+\\w+x']) });
      expect(performance.now() - started).toBeLessThan(30_000);
      expect(result.notes).toEqual([
        'Custom redaction pattern "cubic" was skipped: it exceeded the evaluation time budget on adversarial input',
      ]);
      expect(result.failures).toMatchObject([{ code: 'unsafe', index: 0, label: 'cubic' }]);
    });

    it('[NFR-SEC-05] reports a pattern that is slow on a particular input and keeps the built-in redaction', () => {
      const options = { customPatterns: patterns(['quadratic', '\\w+x']) };
      // Safe-looking (one unbounded quantifier) but O(n^2) on a long run with no match.
      const hostile = `${'a'.repeat(400_000)} reach me at help@customer.io`;
      const started = performance.now();
      const first = redactText(hostile, options);
      // A quadratic scan of 400k characters would run for minutes; the deadline cuts it off.
      expect(performance.now() - started).toBeLessThan(30_000);
      expect(first.text.endsWith('reach me at [REDACTED:email_address#1]')).toBe(true);
      expect(first.complete).toBe(false);
      expect(first.failures).toEqual([
        {
          code: 'timeout',
          index: 0,
          label: 'quadratic',
          message: 'it exceeded its evaluation time budget on this input',
        },
      ]);
      expect(first.notes).toEqual([
        'Custom redaction pattern "quadratic" was not applied: it exceeded its evaluation time budget on this input',
      ]);

      // Nothing is carried over: the next call applies the pattern normally.
      const second = redactText('reference ABCx here', options);
      expect(second.text).toBe('reference [REDACTED:custom] here');
      expect(second.complete).toBe(true);
      expect(second.failures).toEqual([]);
    });

    it('does not let one slow field switch the pattern off for the rest of the upload', () => {
      const options = { customPatterns: patterns(['ticket', '[A-Z]+-[0-9]+']) };
      const poison = 'A'.repeat(400_000);
      const result = redactTexts(['first ACME-1 ok', poison, 'later SECRETCASE-123456'], options);
      expect(result.complete).toBe(false);
      expect(result.failures.map((item) => item.code)).toEqual(['timeout']);
      // What was scanned before the cut-off is redacted; the failure tells the caller the rest was not.
      expect(result.items[0]?.value).toBe('first [REDACTED:custom] ok');
      // A fresh call over the later text redacts it: no `disabled` state survives.
      const again = redactTexts(['later SECRETCASE-123456'], options);
      expect(again.complete).toBe(true);
      expect(again.items[0]?.value).toBe('later [REDACTED:custom]');
    });

    it('names the pattern by label only and never repeats its source or the input', () => {
      const source = 'SRC-\\d{9}';
      const result = redactText('payload with a secret value', {
        customPatterns: [
          { name: `bad${'\u0000'}name${'\u202e'}${'x'.repeat(100)}`, pattern: '(' },
          { name: 'timed out', pattern: source },
        ],
      });
      const failure = result.failures[0];
      expect(failure?.label).toBe(`badname${'x'.repeat(53)}`);
      expect(Object.keys(failure ?? {}).sort()).toEqual(['code', 'index', 'label', 'message']);
      const rendered = JSON.stringify([result.failures, result.notes]);
      expect(rendered).not.toContain(source);
      expect(rendered).not.toContain('secret value');
    });

    it('reports a pattern whose matches never settle instead of stopping quietly', () => {
      const list = patterns(['edge', '\\bab']); // contains an assertion, so replacements are re-checked
      compileCustomPatterns(list);
      const scripted = [
        [0, 4, 2],
        [0, 2, 2],
        [0, 0, 2],
      ];
      let call = 0;
      const runner: PatternRunner = () => ({ kind: 'ok', spans: scripted[call++] ?? [] });
      const result = redactWith(['abcdef'], { customPatterns: list }, withRunner(runner));
      expect(call).toBe(3);
      expect(result.items[0]?.value).toBe('[REDACTED:custom][REDACTED:custom][REDACTED:custom]');
      expect(result.complete).toBe(false);
      expect(result.failures).toEqual([
        {
          code: 'unstable',
          index: 0,
          label: 'edge',
          message:
            'its replacements kept exposing new matches until the re-check limit was reached',
        },
      ]);
    });

    it('ignores patterns beyond the limit and says so', () => {
      const many = patterns(
        ...Array.from({ length: 21 }, (_, i): [string, string] => [`p${i}`, `T${i}X`]),
      );
      const result = redactText('T20X T0X', { customPatterns: many });
      expect(result.text).toBe('T20X [REDACTED:custom]');
      expect(result.notes).toContain('Only the first 20 custom redaction patterns are applied');
      expect(result.failures[0]).toMatchObject({ code: 'too_many', index: 20 });
      expect(result.complete).toBe(false);
    });

    it('copes with hostile names and malformed specs', () => {
      const result = redactText('ok', {
        customPatterns: [
          { name: 'bad\u0000name\u202E' + 'x'.repeat(100), pattern: '(' },
          { name: 42 as unknown as string, pattern: 7 as unknown as string },
          null as unknown as { name: string; pattern: string },
        ],
      });
      expect(result.text).toBe('ok');
      expect(result.notes[0]).toBe(
        `Custom redaction pattern "badname${'x'.repeat(53)}" was skipped: it is not a valid regular expression`,
      );
      expect(result.notes[1]).toBe(
        'Custom redaction pattern "pattern 2" was skipped: the pattern is empty',
      );
      expect(result.notes[2]).toBe(
        'Custom redaction pattern "pattern 3" was skipped: the pattern is empty',
      );
    });

    it('lets callers refuse the payload with a typed error that names labels only', () => {
      const incomplete = redactText('x', { customPatterns: patterns(['broken', '(']) });
      expect(() => {
        assertRedactionComplete(incomplete);
      }).toThrow(RedactionIncompleteError);
      try {
        assertRedactionComplete(incomplete);
      } catch (error) {
        const refusal = error as RedactionIncompleteError;
        expect(refusal.status).toBe(422);
        expect(refusal.code).toBe('unsafe_content');
        expect(refusal.message).toContain('"broken"');
        expect(refusal.message).not.toContain('(');
        expect(refusal.failures).toHaveLength(1);
      }
      expect(() => {
        assertRedactionComplete(redactText('x'));
      }).not.toThrow();
    });
  });

  describe('time budgets (H2, H3)', () => {
    /** A fake clock the fake runner advances, so no test depends on how fast the machine is. */
    function fakeTime(msPerRun: number) {
      let now = 0;
      const deadlines: number[] = [];
      const runner: PatternRunner = (_regex, _texts, _limits, deadlineMs) => {
        deadlines.push(deadlineMs);
        now += msPerRun;
        return { kind: 'ok', spans: [] };
      };
      return { deps: withRunner(runner, { clock: () => now }), deadlines };
    }

    const three = patterns(['a', 'AAA-\\d'], ['b', 'BBB-\\d'], ['c', 'CCC-\\d']);

    it('stops running patterns when the request budget is spent and reports each one it did not run', () => {
      const { deps, deadlines } = fakeTime(60);
      const budget = createCustomPatternBudget(100);
      const result = redactWith(
        ['AAA-1 BBB-2 CCC-3'],
        { customPatterns: three, customPatternBudget: budget },
        deps,
      );
      expect(result.complete).toBe(false);
      expect(result.failures).toEqual([
        {
          code: 'budget_exhausted',
          index: 2,
          label: 'c',
          message:
            'the request ran out of its custom-pattern time budget before this pattern could run',
        },
      ]);
      // Three probe runs, then the first two patterns with what the budget had left.
      expect(deadlines.slice(3)).toEqual([100, 40]);
      expect(budget.remainingMs()).toBe(0);
    });

    it('shares one budget between calls of the same request', () => {
      const { deps } = fakeTime(60);
      const budget = createCustomPatternBudget(100);
      const options = { customPatterns: three, customPatternBudget: budget };
      redactWith(['x'], options, deps);
      const later = redactWith(['AAA-1'], options, deps);
      expect(later.failures.map((item) => [item.code, item.index])).toEqual([
        ['budget_exhausted', 0],
        ['budget_exhausted', 1],
        ['budget_exhausted', 2],
      ]);
      expect(later.items[0]?.value).toBe('AAA-1'); // not redacted, and the failure says so
    });

    it('gives each call its own default budget when the caller does not share one', () => {
      const { deps } = fakeTime(60);
      const options = { customPatterns: three };
      expect(redactWith(['x'], options, deps).complete).toBe(true);
      expect(redactWith(['y'], options, deps).complete).toBe(true);
    });

    it('repeats a run that timed out, once, so a stall of the machine does not refuse the payload', () => {
      const list = patterns(['acct', 'ACME-\\d{4}']);
      compileCustomPatterns(list); // validated (and probed) once, as at save time
      let attempts = 0;
      const flaky: PatternRunner = () => {
        attempts += 1;
        return attempts === 1 ? { kind: 'timeout', spans: [] } : { kind: 'ok', spans: [0, 3, 9] };
      };
      const result = redactWith(['xx ACME-1234'], { customPatterns: list }, withRunner(flaky));
      expect(attempts).toBe(2);
      expect(result.complete).toBe(true);
      expect(result.items[0]?.value).toBe('xx [REDACTED:custom]');
    });

    it('reports the pattern when the repeat times out as well, and does not repeat forever', () => {
      const list = patterns(['acct', 'ACME-\\d{4}']);
      compileCustomPatterns(list);
      let attempts = 0;
      const stuck: PatternRunner = () => {
        attempts += 1;
        return { kind: 'timeout', spans: [] };
      };
      const result = redactWith(['xx ACME-1234'], { customPatterns: list }, withRunner(stuck));
      expect(attempts).toBe(2);
      expect(result.failures).toMatchObject([{ code: 'timeout', index: 0, label: 'acct' }]);
    });

    it('does not repeat a timed-out run when the budget has nothing left for it', () => {
      const list = patterns(['acct', 'ACME-\\d{4}']);
      compileCustomPatterns(list);
      let now = 0;
      let attempts = 0;
      const slow: PatternRunner = () => {
        attempts += 1;
        now += 95;
        return { kind: 'timeout', spans: [] };
      };
      const result = redactWith(
        ['xx ACME-1234'],
        { customPatterns: list, customPatternBudget: createCustomPatternBudget(100) },
        withRunner(slow, { clock: () => now }),
      );
      expect(attempts).toBe(1);
      expect(result.failures).toMatchObject([{ code: 'timeout' }]);
    });

    it('scales the per-pattern deadline with the amount of text, within bounds', () => {
      const { deps, deadlines } = fakeTime(1);
      const options = { customPatterns: patterns(['a', 'AAA-\\d']) };
      redactWith(['x'], options, deps);
      redactWith(['y'.repeat(900_000)], options, deps);
      redactWith(['z'.repeat(9_000_000)], options, deps);
      expect(deadlines.slice(1)).toEqual([201, 650, 2000]); // probe run first; 200 + chars / 2000, capped
    });
  });

  describe('bounded matches (H3)', () => {
    it('reports a pattern that matches more often than the per-text bound allows', () => {
      const result = redactText('7'.repeat(MAX_MATCHES_PER_STRING + 500), {
        customPatterns: patterns(['digit', '\\d']),
      });
      expect(result.failures).toMatchObject([{ code: 'match_limit', index: 0, label: 'digit' }]);
      expect(result.complete).toBe(false);
      expect(result.totalReplacements).toBe(MAX_MATCHES_PER_STRING);
    });

    it('bounds the matches of one pattern over a whole batch too', () => {
      // Limits are lowered through the dependencies so a handful of matches reaches them.
      const result = redactWith(
        ['7 7 7', '7 7 7', '7 7 7'],
        { customPatterns: patterns(['digit', '\\d']) },
        { ...DEFAULT_PATTERN_DEPS, limits: { perString: 100, perBatch: 7 } },
      );
      expect(result.failures).toMatchObject([{ code: 'match_limit', index: 0, label: 'digit' }]);
      expect(result.complete).toBe(false);
      expect(result.totalReplacements).toBe(7);
      expect(result.items.map((item) => item.value)).toEqual([
        '[REDACTED:custom] [REDACTED:custom] [REDACTED:custom]',
        '[REDACTED:custom] [REDACTED:custom] [REDACTED:custom]',
        '[REDACTED:custom] 7 7',
      ]);
    });

    it('uses bounds that leave real text alone: thousands of matches over a bundle are fine', () => {
      expect(MAX_MATCHES_PER_PATTERN).toBeGreaterThanOrEqual(10_000);
      expect(MAX_MATCHES_PER_STRING).toBeGreaterThanOrEqual(1_000);
    });
  });

  describe('compiled patterns are cached by content (H3)', () => {
    it('runs the probe once per distinct pattern, whatever array carries it', () => {
      const { runner, calls } = counting(NO_MATCHES);
      const deps = withRunner(runner);
      compileCustomPatterns(patterns(['first', 'ID-\\d{4}']), deps);
      expect(calls).toHaveLength(1);
      compileCustomPatterns(patterns(['renamed', 'ID-\\d{4}']), deps);
      compileCustomPatterns([{ name: 'again', pattern: 'ID-\\d{4}' }], deps);
      redactText('x', { customPatterns: patterns(['other name', 'ID-\\d{4}']) });
      expect(calls).toHaveLength(1);
      compileCustomPatterns(patterns(['second', 'ID-\\d{5}']), deps);
      expect(calls).toHaveLength(2);
    });

    it('does not probe at all while redacting once the pattern has been validated', () => {
      const list = patterns(['acct', 'ACME\\d-[0-9]{6}']);
      compileCustomPatterns(list); // save-time validation
      const spy = vi.spyOn(vm.Script.prototype, 'runInContext');
      redactTexts(['one ACME1-123456', 'two'], { customPatterns: [...list] });
      expect(spy).toHaveBeenCalledTimes(1); // the evaluation itself, not a probe
    });

    it('keeps the cache small: least recently used patterns are evicted and re-probed on return', () => {
      const { runner, calls } = counting(NO_MATCHES);
      const deps = withRunner(runner);
      const compile = (i: number) =>
        compileCustomPatterns(patterns([`p${i}`, `K${i}-\\d{3}`]), deps);
      for (let i = 0; i < 256; i += 1) compile(i);
      expect(customPatternCacheSize()).toBe(256);
      compile(0); // touch: now the most recently used
      for (let i = 256; i < 261; i += 1) compile(i); // evicts the five least recent: 1..5
      expect(customPatternCacheSize()).toBe(256);
      const before = calls.length;
      compile(0);
      expect(calls.length).toBe(before); // still cached
      compile(1);
      expect(calls.length).toBe(before + 1); // evicted, probed again
    });

    it('caches rejections too, so a hostile pattern costs one analysis', () => {
      const { runner, calls } = counting(NO_MATCHES);
      const deps = withRunner(runner);
      for (let i = 0; i < 5; i += 1) {
        const compiled = compileCustomPatterns(patterns(['nested', '(a+)+$']), deps);
        expect(compiled.entries).toEqual([]);
      }
      expect(calls).toHaveLength(0); // rejected statically: never even probed
      expect(customPatternCacheSize()).toBe(1);
    });

    it('forgets a probe timeout after a while, because it may have been a stall', () => {
      let wallClock = 1_000;
      let stalled = true;
      const { runner, calls } = counting(() => ({ kind: stalled ? 'timeout' : 'ok', spans: [] }));
      const deps = withRunner(runner, { wallClock: () => wallClock });
      const list = patterns(['slow', 'ID-\\d{4}']);

      const first = compileCustomPatterns(list, deps);
      expect(first.failures).toMatchObject([{ code: 'unsafe', label: 'slow' }]);
      expect(calls).toHaveLength(2); // one retry before the verdict

      compileCustomPatterns(list, deps);
      expect(calls).toHaveLength(2); // cached verdict

      stalled = false;
      wallClock += 6 * 60_000;
      const later = compileCustomPatterns(list, deps);
      expect(later.entries).toHaveLength(1); // probed again and fine now
      expect(calls).toHaveLength(3);
    });
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

  it('exposes compileCustomPatterns for settings validation (never throws)', () => {
    const compiled = compileCustomPatterns(patterns(['good', 'ID-\\d+'], ['bad', '(']));
    expect(compiled.entries.map((entry) => entry.name)).toEqual(['good']);
    expect(compiled.notes).toHaveLength(1);
    expect(compiled.failures).toMatchObject([{ code: 'invalid', index: 1, label: 'bad' }]);
  });
});

describe(
  'one sandbox evaluation per pattern and batch, not per string (H3)',
  { timeout: 120_000 },
  () => {
    const acct = patterns(['acct', 'ACME\\d-[0-9]{6}']);
    const lines = (count: number, size = 400): string[] =>
      Array.from(
        { length: count },
        (_, i) =>
          `event ${i} ${'lorem ipsum '.repeat(Math.ceil(size / 12)).slice(0, size)} ACME1-${100_000 + i}`,
      );

    /** Validation (and the one probe) happens at save time, so it is done before counting. */
    const warm = (list: ReturnType<typeof patterns>) => {
      compileCustomPatterns(list);
      return vi.spyOn(vm.Script.prototype, 'runInContext');
    };

    it('evaluates 2,000 strings with one pattern in a single call', () => {
      const spy = warm(acct);
      const result = redactTexts(lines(2_000), { customPatterns: acct });
      expect(result.complete).toBe(true);
      expect(result.totalReplacements).toBe(2_000);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('makes patterns x batches calls: five patterns over two batches are ten calls', () => {
      const five = patterns(
        ...[1, 2, 3, 4, 5].map((n): [string, string] => [`p${n}`, `NOPE${n}-\\d{6}`]),
      );
      const spy = warm(five);
      const options = { customPatterns: five };
      redactTexts(lines(300), options);
      redactTexts(lines(300), options);
      expect(spy).toHaveBeenCalledTimes(10);
    });

    it('batches JSON-like values too: every string leaf shares the evaluation', () => {
      const spy = warm(acct);
      const records = Array.from({ length: 100 }, (_, i) => ({
        title: `case ${i} ACME1-${200_000 + i}`,
        tags: ['a', 'b', `ACME2-${300_000 + i}`],
        nested: { note: `note ${i}`, deeper: [{ text: `ACME3-${400_000 + i}` }] },
      }));
      const result = redactValues(records, { customPatterns: acct });
      expect(result.complete).toBe(true);
      expect(result.totalReplacements).toBe(300);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('needs no sandbox call at all without custom patterns', () => {
      const spy = vi.spyOn(vm.Script.prototype, 'runInContext');
      redactTexts(lines(200), {});
      redactValues([{ password: 'x', note: 'ACME1-123456' }], {});
      expect(spy).not.toHaveBeenCalled();
    });

    it('looks again only when an assertion in a pattern depends on the neighbouring text', () => {
      const plain = patterns(['foo', 'foo']);
      const contextual = patterns(['foo', '\\bfoo\\b']);
      const spy = warm([...plain, ...contextual]);
      redactText('foo bar', { customPatterns: plain });
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockClear();
      redactText('foo bar', { customPatterns: contextual });
      expect(spy).toHaveBeenCalledTimes(2); // the confirming round, over the strings that changed
      spy.mockClear();
      redactText('nothing here', { customPatterns: contextual });
      expect(spy).toHaveBeenCalledTimes(1); // no match, nothing changed, nothing to re-check
    });

    it('the deprecated per-field functions still evaluate once per string and pattern', () => {
      const spy = warm(acct);
      for (const text of lines(20)) redactText(text, { customPatterns: acct });
      expect(spy).toHaveBeenCalledTimes(20);
    });

    it('keeps the batch results identical to redacting the strings one by one', () => {
      const options = {
        customPatterns: patterns(['acct', 'ACME\\d-[0-9]{6}'], ['ref', '\\bREF\\d+\\b']),
      };
      const texts = [
        'ava@customer.io wrote ACME1-123456',
        'again ava@customer.io and bob@fabrikam.io REF42',
        'nothing',
        'call +1 425 555 0100 REF7 ACME2-654321',
      ];
      const state = createPseudonymState();
      const sequential = texts.map((text) => redactText(text, options, state));
      const batch = redactTexts(texts, options);
      expect(batch.items.map((item) => item.value)).toEqual(sequential.map((item) => item.text));
      expect(batch.items.map((item) => item.totalReplacements)).toEqual(
        sequential.map((item) => item.totalReplacements),
      );
    });

    it('[generous bound] a 2,000-event, ~1.6 MB bundle with one tenant pattern is a single evaluation', () => {
      const spy = warm(acct);
      const events = Array.from({ length: 2_000 }, (_, i) => ({
        title: `Sign-in loop ${i}`,
        body: lines(1, 700)[0] ?? '',
        action: { label: `Reset session ${i}` },
        correlationIds: [`corr-${i}`],
      }));
      const started = performance.now();
      const result = redactValues(events, { customPatterns: acct });
      const elapsed = performance.now() - started;
      expect(result.complete).toBe(true);
      expect(result.totalReplacements).toBe(2_000);
      expect(spy).toHaveBeenCalledTimes(1);
      // Before batching this took minutes (one sandbox call per field). Generous, but still separates the two.
      expect(elapsed).toBeLessThan(60_000);
    });
  },
);

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
