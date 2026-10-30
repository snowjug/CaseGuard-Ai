import { describe, expect, it } from 'vitest';
import { MAX_REDACTION_PASSES, redactBatchInto, type EngineConfig } from '../src/redaction/engine';
import { createTally, findingsFrom, redactText } from '../src/redaction/redact-text';
import { createPseudonymState } from '../src/redaction/pseudonyms';
import type { RedactionRule } from '../src/redaction/rules';
import { secrets } from './helpers/secrets';

function expectStable(text: string) {
  const once = redactText(text);
  const twice = redactText(once.text);
  expect(twice.text).toBe(once.text);
  expect(twice.totalReplacements).toBe(0);
  return once;
}

describe('redactText: idempotency regressions', () => {
  // Each case below was a counterexample found by fuzzing.
  it('does not redact the placeholder another rule just wrote', () => {
    expect(expectStable('token:password=?').text).toBe(
      'token:password=[REDACTED:password_assignment]',
    );
  });

  it('does not let a connection-string match reach across placeholders', () => {
    const once = expectStable('https://password=postgres://u:p@h/d');
    expect(once.text).not.toContain('u:p@');
  });

  it('redacts a value that a later replacement exposes, within one call', () => {
    const key = secrets.storageAccountKey();
    // Glued to an address the key is not a standalone token; once the address is replaced it is.
    const once = expectStable(`${key}a@b.co`);
    expect(once.text).toBe('[REDACTED:azure_storage_key][REDACTED:email_address#1]');
    expect(once.findings.map((finding) => [finding.category, finding.count])).toEqual([
      ['azure_storage_key', 1],
      ['email_address', 1],
    ]);
    expect(once.totalReplacements).toBe(2);
  });

  it('is stable for text that already contains placeholders next to credentials', () => {
    for (const text of [
      'password=[REDACTED:password_assignment]',
      'Authorization: Bearer [REDACTED:bearer_token]',
      'postgres://[REDACTED:connection_string]@db.internal/app',
      'postgres://admin:[REDACTED:password_assignment]@db.internal/app',
      'api_key=[REDACTED:api_key] and token: [REDACTED:jwt]',
      'user [REDACTED:email_address#1] called [REDACTED:phone_number#1] from [REDACTED:ipv4_address#1]',
    ]) {
      expectStable(text);
    }
  });

  it('reports a text that needed no change with zero replacements', () => {
    const result = redactText('nothing to see here: 42 widgets shipped');
    expect(result.totalReplacements).toBe(0);
    expect(result.findings).toEqual([]);
  });
});

describe('redactInto: pass loop', () => {
  const rule = (
    category: RedactionRule['category'],
    pattern: RegExp,
    replacement: (matched: string) => string,
  ): RedactionRule => ({
    category,
    apply: (doc, context) =>
      doc.replace(pattern, (matched: string) => {
        context.hit(category);
        return replacement(matched);
      }),
  });

  function run(text: string, engine: Partial<EngineConfig>) {
    const tally = createTally();
    const outcome = redactBatchInto([text], {}, createPseudonymState(), [tally], engine);
    return { out: outcome.texts[0] ?? '', tally };
  }

  // `Y` becomes `!` only after the first rule has already looked at the text.
  const exposesLater: readonly RedactionRule[] = [
    rule('api_key', /X!/g, () => '[REDACTED:api_key]'),
    rule('jwt', /Y/g, () => '!'),
  ];

  it('applies the rules again when a pass exposed something the first pass could not see', () => {
    expect(run('XY', { rules: exposesLater, maxPasses: 1 }).out).toBe('X!');
    const { out, tally } = run('XY', { rules: exposesLater, maxPasses: MAX_REDACTION_PASSES });
    expect(out).toBe('[REDACTED:api_key]');
    expect(findingsFrom(tally).map((finding) => [finding.category, finding.count])).toEqual([
      ['api_key', 1],
      ['jwt', 1],
    ]);
  });

  it('stops after the pass limit instead of looping on rules that never settle', () => {
    const growing = [rule('api_key', /a/g, () => 'aa')];
    expect(run('a', { rules: growing, maxPasses: 3 }).out).toBe('a'.repeat(8));
    expect(run('a', { rules: growing, maxPasses: 1 }).out).toBe('aa');
  });

  it('does not count what a confirming pass reported without changing the text', () => {
    const redetectsPlaceholder: RedactionRule = {
      category: 'jwt',
      apply(doc, context) {
        const seen = [...doc.text.matchAll(/\[REDACTED:api_key\]/g)].length;
        for (let i = 0; i < seen; i += 1) context.hit('jwt');
      },
    };
    const engine = {
      rules: [rule('api_key', /X/g, () => '[REDACTED:api_key]'), redetectsPlaceholder],
      maxPasses: MAX_REDACTION_PASSES,
    };
    const { out, tally } = run('X', engine);
    expect(out).toBe('[REDACTED:api_key]');
    // One from the first pass; the confirming pass saw the placeholder again but changed nothing.
    expect(tally.counts.get('jwt')).toBe(1);
    expect(tally.counts.get('api_key')).toBe(1);
  });

  it('does no extra work for text the first pass left alone', () => {
    let calls = 0;
    const counting: RedactionRule = {
      category: 'api_key',
      apply() {
        calls += 1;
      },
    };
    run('plain text', { rules: [counting], maxPasses: MAX_REDACTION_PASSES });
    expect(calls).toBe(1);
  });
});
