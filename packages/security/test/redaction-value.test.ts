import { describe, expect, it } from 'vitest';
import { createPseudonymState } from '../src/redaction/pseudonyms';
import { redactValue } from '../src/redaction/redact-value';
import { secrets } from './helpers/secrets';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const member of Object.values(value)) deepFreeze(member);
  }
  return value;
}

describe('redactValue', () => {
  it('redacts every string in nested JSON and leaves other types untouched', () => {
    const when = new Date('2025-01-01T00:00:00.000Z');
    const input = {
      id: 'evt_1',
      count: 3,
      ok: true,
      nothing: null,
      when,
      body: `ping a@customer.io from 8.8.8.8 with Bearer ${secrets.bearerToken()}`,
      tags: ['x', `mail b@customer.io`, [`deep ${secrets.githubToken()}`]],
      nested: { note: 'call +1 425 555 0100' },
    };
    const { value, totalReplacements, findings } = redactValue(input);
    expect(value).toEqual({
      id: 'evt_1',
      count: 3,
      ok: true,
      nothing: null,
      when,
      body: 'ping [REDACTED:email_address#1] from [REDACTED:ipv4_address#1] with Bearer [REDACTED:bearer_token]',
      tags: ['x', 'mail [REDACTED:email_address#2]', ['deep [REDACTED:github_token]']],
      nested: { note: 'call [REDACTED:phone_number#1]' },
    });
    expect(value.when).toBe(when);
    expect(totalReplacements).toBe(6);
    expect(findings.map((f) => f.category)).toEqual([
      'bearer_token',
      'github_token',
      'email_address',
      'ipv4_address',
      'phone_number',
    ]);
  });

  it('never mutates its input', () => {
    const input = deepFreeze({
      a: `password=${secrets.password()}`,
      list: [{ mail: 'a@customer.io' }],
      password: 'hunter2',
    });
    const snapshot = JSON.stringify(input);
    const { value } = redactValue(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(value).not.toBe(input);
    expect(value.list).not.toBe(input.list);
  });

  it('redacts string values under secret-named properties even without context in the text', () => {
    const { value, findings } = redactValue({
      password: 'hunter2',
      dbPassword: 'x',
      'client-secret': 'abc',
      apiKey: 'k',
      accessToken: 't',
      Authorization: 'Bearer short',
      connectionString: 'anything at all',
      privateKey: 'not even pem',
      user: { passphrase: 'correct horse', name: 'Ava' },
      tokenCount: 12,
      passwordLength: 8,
      passwordPolicy: 'complex',
      isPasswordSet: 'yes',
    });
    expect(value).toEqual({
      password: '[REDACTED:password_assignment]',
      dbPassword: '[REDACTED:password_assignment]',
      'client-secret': '[REDACTED:password_assignment]',
      apiKey: '[REDACTED:api_key]',
      accessToken: '[REDACTED:bearer_token]',
      Authorization: '[REDACTED:bearer_token]',
      connectionString: '[REDACTED:connection_string]',
      privateKey: '[REDACTED:private_key]',
      user: { passphrase: '[REDACTED:password_assignment]', name: 'Ava' },
      tokenCount: 12,
      passwordLength: 8,
      passwordPolicy: 'complex',
      isPasswordSet: 'yes',
    });
    expect(findings.map((f) => f.category)).toEqual([
      'bearer_token',
      'api_key',
      'connection_string',
      'private_key',
      'password_assignment',
    ]);
  });

  it('respects enabledCategories for key-based redaction too', () => {
    const { value } = redactValue(
      { password: 'hunter2', mail: 'a@customer.io' },
      { enabledCategories: ['email_address'] },
    );
    expect(value).toEqual({ password: 'hunter2', mail: '[REDACTED:email_address#1]' });
  });

  it('does not re-redact values that are already placeholders or empty', () => {
    const { value, totalReplacements } = redactValue({
      password: '[REDACTED:password_assignment]',
      token: '',
    });
    expect(value).toEqual({ password: '[REDACTED:password_assignment]', token: '' });
    expect(totalReplacements).toBe(0);
  });

  it('shares one pseudonym state across the whole document and across calls', () => {
    const state = createPseudonymState();
    const first = redactValue(
      { from: 'a@customer.io', to: ['b@customer.io', 'a@customer.io'] },
      {},
      state,
    );
    expect(first.value).toEqual({
      from: '[REDACTED:email_address#1]',
      to: ['[REDACTED:email_address#2]', '[REDACTED:email_address#1]'],
    });
    const second = redactValue({ cc: 'c@customer.io', again: 'b@customer.io' }, {}, state);
    expect(second.value).toEqual({
      cc: '[REDACTED:email_address#3]',
      again: '[REDACTED:email_address#2]',
    });
  });

  it('keeps a JSON-parsed "__proto__" key as plain data and does not touch prototypes', () => {
    const parsed: unknown = JSON.parse('{"__proto__": {"admin": true}, "note": "a@customer.io"}');
    const { value } = redactValue(parsed) as { value: Record<string, unknown> };
    expect(Object.keys(value)).toEqual(['__proto__', 'note']);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(({} as { admin?: boolean }).admin).toBeUndefined();
    expect(value['note']).toBe('[REDACTED:email_address#1]');
  });

  it('rejects circular structures and absurd nesting instead of looping', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    expect(() => redactValue(cyclic)).toThrow(TypeError);

    let deep: unknown = 'x';
    for (let i = 0; i < 150; i += 1) deep = { next: deep };
    expect(() => redactValue(deep)).toThrow(RangeError);
  });

  it('allows shared (non-circular) references', () => {
    const shared = { mail: 'a@customer.io' };
    const { value } = redactValue({ one: shared, two: shared });
    expect(value).toEqual({
      one: { mail: '[REDACTED:email_address#1]' },
      two: { mail: '[REDACTED:email_address#1]' },
    });
  });

  it('handles primitives, empty containers and arrays at the root', () => {
    expect(redactValue('a@customer.io').value).toBe('[REDACTED:email_address#1]');
    expect(redactValue(42).value).toBe(42);
    expect(redactValue(null).value).toBeNull();
    expect(redactValue([]).value).toEqual([]);
    expect(redactValue({}).value).toEqual({});
    expect(redactValue(['a@customer.io']).value).toEqual(['[REDACTED:email_address#1]']);
  });

  it('collects each custom-pattern note once', () => {
    const { notes } = redactValue(
      { a: 'x', b: 'y', c: ['z'] },
      { customPatterns: [{ name: 'broken', pattern: '(' }] },
    );
    expect(notes).toEqual([
      'Custom redaction pattern "broken" was skipped: it is not a valid regular expression',
    ]);
  });

  it('is idempotent', () => {
    const input = {
      msg: `Bearer ${secrets.bearerToken()} a@customer.io`,
      password: 'p',
      list: ['8.8.8.8', `postgres://u:${secrets.password()}@h/db`],
    };
    const once = redactValue(input).value;
    const twice = redactValue(once);
    expect(twice.value).toEqual(once);
    expect(twice.totalReplacements).toBe(0);
  });
});
