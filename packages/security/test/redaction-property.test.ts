import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { redactText } from '../src/redaction/redact-text';
import { B62, URLSAFE, fixture, secrets } from './helpers/secrets';

const chars = (alphabet: string) => fc.constantFrom(...alphabet.split(''));
const word = (alphabet: string, min: number, max: number) =>
  fc.array(chars(alphabet), { minLength: min, maxLength: max }).map((parts) => parts.join(''));

const LOWER = 'abcdefghijklmnopqrstuvwxyz';

/** A value that must not survive redaction, together with the text that embeds it. */
interface Planted {
  readonly secret: string;
  readonly text: string;
}

const planted: fc.Arbitrary<Planted> = fc.oneof(
  word(URLSAFE, 20, 60).map((token) => ({ secret: token, text: `Authorization: Bearer ${token}` })),
  word(B62, 36, 44).map((token) => ({ secret: `ghp_${token}`, text: `pushed with ghp_${token}` })),
  word(B62, 40, 48).map((token) => ({ secret: `sk-${token}7`, text: `key sk-${token}7 leaked` })),
  word(B62, 14, 30).map((value) => ({ secret: `A1${value}`, text: `api_key=A1${value}` })),
  word(`${B62}!@#$%^*_-`, 6, 24).map((value) => ({
    secret: `Z9${value}`,
    text: `password=Z9${value}`,
  })),
  word(`${B62}!@#$%^*_-`, 6, 24).map((value) => ({
    secret: `Z9${value}`,
    text: `{"password": "Z9${value}"}`,
  })),
  fc.tuple(word(`${LOWER}0123456789`, 3, 12), word(LOWER, 3, 10)).map(([local, domain]) => ({
    secret: `${local}@${domain}.com`,
    text: `contact ${local}@${domain}.com today`,
  })),
  fc
    .tuple(
      fc.integer({ min: 11, max: 126 }),
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 1, max: 254 }),
    )
    .map(([a, b, c, d]) => ({
      secret: `${a}.${b}.${c}.${d}`,
      text: `from ${a}.${b}.${c}.${d}:443`,
    })),
  fc
    .tuple(word(URLSAFE, 10, 30), word(URLSAFE, 10, 30), word(URLSAFE, 10, 43))
    .map(([h, p, s]) => ({
      secret: `eyJ${h}.eyJ${p}.${s}`,
      text: `id_token=eyJ${h}.eyJ${p}.${s}`,
    })),
  word(B62, 8, 16).map((pass) => ({
    secret: `Q8${pass}`,
    text: `postgres://svc:Q8${pass}@db.contoso.example/app`,
  })),
);

const noise = word(`${LOWER} `, 0, 60);

const UPPER_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const octet = fc.integer({ min: 0, max: 300 });
/** `REDACTION_FUZZ_RUNS=200000` turns the idempotency property into a deep hunt (about a minute). */
const DEEP_RUNS =
  Number(process.env.REDACTION_FUZZ_RUNS) > 0 ? Number(process.env.REDACTION_FUZZ_RUNS) : null;

/** Whole secret-shaped values: loose fragments alone rarely reach the lengths the rules require. */
const wholeValue: fc.Arbitrary<string> = fc.oneof(
  word(B62, 36, 40).map((token) => `ghp_${token}`),
  fc
    .tuple(word(URLSAFE, 6, 12), word(URLSAFE, 6, 12), word(URLSAFE, 0, 10))
    .map(([h, p, s]) => `eyJ${h}.eyJ${p}.${s}`),
  word(UPPER_DIGITS, 16, 16).map((id) => `AKIA${id}`),
  word(URLSAFE, 20, 30).map((token) => `sk-${token}`),
  word(`${B62}+/`, 86, 86).map((key) => `${key}==`),
  word(`${B62}%`, 20, 30).map((signature) => `sig=${signature}`),
  word(B62, 16, 40).map(
    (body) => `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`,
  ),
  word(B62, 16, 40).map((body) => `-----BEGIN PRIVATE KEY-----\n${body}`),
  fc
    .tuple(word(LOWER, 1, 8), word(LOWER, 1, 6), fc.constantFrom('com', 'io', 'co.uk', 'invalid'))
    .map(([local, domain, tld]) => `${local}@${domain}.${tld}`),
  fc.tuple(octet, octet, octet, octet).map((parts) => parts.join('.')),
  fc
    .tuple(word('0123456789', 3, 3), word('0123456789', 4, 4))
    .map(([area, line]) => `${area}-555-${line}`),
  fc
    .tuple(
      fc.constantFrom('postgres', 'redis', 'https', 'amqp'),
      word(LOWER, 1, 6),
      word(B62, 1, 10),
      word(LOWER, 1, 6),
    )
    .map(([scheme, user, pass, host]) => `${scheme}://${user}:${pass}@${host}`),
  word(B62, 8, 30),
);

const KEYWORDS = [
  'password=',
  'Password=',
  'passwd:',
  'client_secret=',
  'Bearer ',
  'Authorization: ',
  'Authorization: Basic ',
  'Proxy-Authorization: Bearer ',
  'Cookie: ',
  'Set-Cookie: ',
  'api_key=',
  'x-api-key: ',
  'token:',
  'refresh_token: ',
  'AccountKey=',
  'SharedAccessSignature=',
  '?sig=',
  '&sig=',
  'Server=x;',
  ';Password=',
  ';Pwd=',
  '[REDACTED:',
  '[REDACTED:api_key]',
  '[REDACTED:email_address#1]',
  ']',
  '#1',
  '@',
  '.',
  '://',
  'postgres://',
  'https://',
  ':',
  ';',
  '=',
  '==',
  '&',
  '?',
  '/',
  '-',
  '_',
  '\n',
  '\r\n',
  '\t',
  ' ',
  '  ',
  '"',
  "'",
  '(',
  ')',
  '{',
  '}',
  '<',
  '>',
  ',',
  '+1 ',
  '(425) ',
  '425-',
  '0100',
  '256.1.1.1',
  '10.0.0.1',
  'example.com',
  'ava@contoso.invalid',
  'postgres://u:p@h/d',
  'x://:',
  '+',
  'null',
  '***',
  '${VAR}',
  '<key>',
  '%',
  '$',
  '!',
];

const richFragment: fc.Arbitrary<string> = fc.oneof(
  { weight: 7, arbitrary: fc.constantFrom(...KEYWORDS) },
  { weight: 3, arbitrary: word(B62, 1, 24) },
  { weight: 3, arbitrary: wholeValue },
  { weight: 1, arbitrary: fc.string({ maxLength: 6 }) },
);

describe('redactText: properties', { timeout: 120_000 }, () => {
  it('[NFR-PRIV-01] no planted secret survives, wherever it sits in arbitrary surrounding text', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(noise, planted), { minLength: 1, maxLength: 5 }), (parts) => {
        const text = parts.map(([filler, item]) => `${filler}\n${item.text}\n`).join('');
        const result = redactText(text);
        for (const [, item] of parts) {
          if (result.text.includes(item.secret)) return false;
        }
        return result.totalReplacements >= parts.length;
      }),
      { numRuns: 300 },
    );
  });

  it('is idempotent on arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (text) => {
        const once = redactText(text);
        const twice = redactText(once.text);
        return twice.text === once.text && twice.totalReplacements === 0;
      }),
      { numRuns: 300 },
    );
  });

  it('is idempotent on adversarial mixtures of secret-looking fragments', () => {
    const fragment = fc.oneof(
      fc.constantFrom(
        'password=',
        'Password=',
        'pwd:',
        'Bearer ',
        'Authorization: ',
        'Cookie: ',
        'api_key=',
        'token:',
        '@',
        '.',
        '://',
        ';',
        '=',
        '==',
        'AccountKey=',
        'sig=',
        '-----BEGIN ',
        'PRIVATE KEY-----',
        '-----END ',
        'eyJ',
        'ghp_',
        'sk-',
        '[REDACTED:',
        ']',
        '#1',
        '\n',
        ' ',
        '"',
        "'",
        '+1 ',
        '(425) ',
        '555-',
        '0100',
        '1.2.3.4',
        '10.0.0.1',
        '8.8.8.8',
        'example.com',
        'a@b.co',
        'postgres://u:p@h/d',
        '+',
        '1',
      ),
      word(B62, 1, 24),
      fc.string({ maxLength: 6 }),
    );
    fc.assert(
      fc.property(fc.array(fragment, { maxLength: 40 }), (parts) => {
        const text = parts.join('');
        const once = redactText(text);
        const twice = redactText(once.text);
        return twice.text === once.text && twice.totalReplacements === 0;
      }),
      { numRuns: 500 },
    );
  });

  it('is idempotent on mixtures of whole secrets, URLs, keys and neighbouring placeholders', () => {
    fc.assert(
      fc.property(fc.array(richFragment, { maxLength: 30 }), (parts) => {
        const text = parts.join('');
        const once = redactText(text);
        const twice = redactText(once.text);
        return twice.text === once.text && twice.totalReplacements === 0;
      }),
      { numRuns: DEEP_RUNS ?? 1500 },
    );
  });

  it('never reports more replacements than it makes, and findings add up', () => {
    fc.assert(
      fc.property(fc.array(planted, { minLength: 1, maxLength: 6 }), (items) => {
        const result = redactText(items.map((item) => item.text).join('\n'));
        const sum = result.findings.reduce((total, finding) => total + finding.count, 0);
        return sum === result.totalReplacements && result.findings.every((f) => f.count >= 1);
      }),
      { numRuns: 100 },
    );
  });

  it('does not alter text that contains nothing sensitive', () => {
    fc.assert(
      fc.property(word(`${LOWER.toUpperCase()}${LOWER} .,;!?-\n`, 0, 300), (text) => {
        return redactText(text).text === text;
      }),
      { numRuns: 200 },
    );
  });
});

// Budgets are generous on purpose: a quadratic pattern needs minutes on 1 MiB, a linear one well under a
// second, so the tests still separate the two even on a heavily loaded machine.
describe('redactText: hostile input stays linear (NFR-SEC-05)', { timeout: 180_000 }, () => {
  const MEGABYTE = 1024 * 1024;
  const repeatTo = (unit: string, size = MEGABYTE) =>
    unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

  const shapes: Record<string, string> = {
    'one long identifier': repeatTo('a'),
    'one long digit run': repeatTo('7'),
    'dotted digits': repeatTo('1.'),
    'dotted quad fragments': repeatTo('1.2.3.'),
    'at signs': repeatTo('a@'),
    'at signs and dots': repeatTo('a@b.'),
    'local-part run then no at': repeatTo('a.b-c_d+e%f'),
    'unterminated PEM headers': repeatTo('-----BEGIN PRIVATE KEY-----'),
    'PEM header with huge body': `-----BEGIN RSA PRIVATE KEY-----${repeatTo('A', MEGABYTE - 40)}`,
    'bearer prefixes': repeatTo('Bearer '),
    'bearer then whitespace': `Bearer${repeatTo(' ')}`,
    'password prefixes': repeatTo('password='),
    'password then spaces': `password${repeatTo(' ')}`,
    'connection-string pairs': repeatTo('a=b;'),
    'jwt prefixes': repeatTo('eyJ'),
    'jwt dotted': repeatTo('eyJabcdef.'),
    'url scheme prefixes': repeatTo('x://:'),
    'scheme then long password': `x://:${repeatTo('p')}`,
    'quoted key fragments': repeatTo('token="'),
    'api key prefixes': repeatTo('sk-'),
    'phone fragments': repeatTo('+1 '),
    'phone digits and separators': repeatTo('425-555-'),
    'base64-like run': repeatTo('Ab+/'),
    'slashes and hyphens': repeatTo('-/'),
    'AccountKey fragments': repeatTo('AccountKey='),
    'cookie headers': repeatTo('Cookie:'),
    whitespace: repeatTo(' \t\r\n'),
  };

  it.each(Object.entries(shapes))(
    'handles 1 MiB of %s well inside the time budget',
    (_name, input) => {
      const started = performance.now();
      const result = redactText(input);
      const elapsed = performance.now() - started;
      expect(result.text.length > 0).toBe(true);
      // A quadratic pattern needs minutes here; a linear one needs well under a second.
      expect(elapsed).toBeLessThan(30_000);
    },
  );

  it('redacts a realistic 1 MiB log full of secrets correctly and quickly', () => {
    const record = (i: number): string =>
      [
        `2025-01-31T12:30:${String(i % 60).padStart(2, '0')}Z INFO request ${i} from 8.8.${i % 250}.${(i * 7) % 250}`,
        `  Authorization: Bearer ${fixture(40, URLSAFE, i + 1)}`,
        `  user=u${i}@customer.io password=Zq${fixture(12, B62, i + 2)}`,
        `  contact +1 425 555 ${String(1000 + (i % 9000))}`,
        '  details: nothing sensitive here, just ordinary diagnostic text about timeouts',
      ].join('\n');
    const lines: string[] = [];
    let size = 0;
    for (let i = 0; size < MEGABYTE; i += 1) {
      const chunk = record(i);
      lines.push(chunk);
      size += chunk.length + 1;
    }
    const text = lines.join('\n');
    const started = performance.now();
    const result = redactText(text);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(60_000);
    // Boolean checks only: a failing diff of a 1 MiB string would drown the test output.
    expect(/Bearer [A-Za-z0-9_-]{16,}/.test(result.text)).toBe(false);
    expect(result.text.includes('password=Zq')).toBe(false);
    expect(result.text.includes('@customer.io')).toBe(false);
    expect(result.text.split('\n').length).toBe(lines.length * 5);
    expect(result.findings.map((f) => f.category)).toEqual([
      'bearer_token',
      'password_assignment',
      'email_address',
      'ipv4_address',
      'phone_number',
    ]);
  });

  it('keeps secrets from hiding in a large benign document', () => {
    const filler = repeatTo('lorem ipsum dolor sit amet, consectetur adipiscing elit. ', MEGABYTE);
    const token = secrets.githubToken(9);
    const text = `${filler}\n${token}\n${filler}`;
    const result = redactText(text);
    expect(result.text.includes(token)).toBe(false);
    expect(result.totalReplacements).toBe(1);
  });
});
