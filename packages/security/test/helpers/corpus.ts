/*
 * Deterministic corpus generator for the redaction regression tests. Every input is assembled at
 * runtime from a seeded generator (no secret-shaped literal is stored anywhere), so the golden
 * fixture only needs to keep hashes of the expected output.
 */
import { B62, URLSAFE, fixture, secrets } from './secrets';

export interface Rng {
  next(): number;
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
}

/** mulberry32: small, fast, good enough for test data. */
export function rng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
    pick: (items) => items[Math.floor(next() * items.length)] as (typeof items)[number],
  };
}

const KEYWORDS = [
  'password=',
  'Password=',
  'passwd:',
  'pwd=',
  'client_secret=',
  'passphrase:',
  'db_password=',
  'Bearer ',
  'Authorization: ',
  'Authorization: Basic ',
  'Proxy-Authorization: Bearer ',
  'Cookie: ',
  'Set-Cookie: ',
  'api_key=',
  'x-api-key: ',
  'apikey:',
  'token:',
  'access_token=',
  'refresh_token: ',
  'subscription-key=',
  'AccountKey=',
  'SharedAccessKey=',
  'InstrumentationKey=',
  'sig=',
  '?sig=',
  '&sig=',
  'Server=x;',
  ';Password=',
  ';Pwd=',
  '-----BEGIN ',
  'PRIVATE KEY-----',
  '-----END ',
  'eyJ',
  'ghp_',
  'sk-',
  'AKIA',
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
  '555-',
  '0100',
  '1.2.3.4',
  '10.0.0.1',
  '8.8.8.8',
  '192.168.1.1',
  '256.1.1.1',
  'example.com',
  'a@b.co',
  'user@host.com',
  'ava@contoso.invalid',
  'null',
  'true',
  '***',
  'xxxx',
  '${VAR}',
  '<key>',
  '{{x}}',
  '%',
  '$',
  '!',
  'plain words about a customer and a timeout',
  'HTTP 502 for several users',
];

const SEPARATORS = [' ', ' ', ' ', '\n', '\t', ', ', '; ', ' = ', ': ', '\r\n', ''];
const DOMAINS = ['customer.io', 'contoso.invalid', 'example.com', 'fabrikam.example', 'mail.org'];
const TLDS = ['com', 'io', 'invalid', 'org'];

type Fragment = (random: Rng) => string;

const seedOf = (random: Rng): number => random.int(1_000_000);

const composed: readonly Fragment[] = [
  (r) => secrets.githubToken(seedOf(r)),
  (r) => secrets.jwt(seedOf(r)),
  (r) => secrets.awsAccessKeyId(seedOf(r)),
  (r) => secrets.openAiKey(seedOf(r)),
  (r) => secrets.googleKey(seedOf(r)),
  (r) => secrets.slackToken(seedOf(r)),
  (r) => secrets.stripeKey(seedOf(r)),
  (r) => secrets.npmToken(seedOf(r)),
  (r) => secrets.sendGridKey(seedOf(r)),
  (r) => secrets.entraClientSecret(seedOf(r)),
  (r) => secrets.storageAccountKey(seedOf(r)),
  (r) => `?sig=${secrets.sasSignature(seedOf(r))}`,
  (r) => `password=${secrets.password(seedOf(r))}`,
  (r) => `password: ${secrets.password(seedOf(r))}`,
  (r) => `client_secret = ${secrets.password(seedOf(r))}`,
  (r) => `api_key=${secrets.apiKeyValue(seedOf(r))}`,
  (r) => `token: ${secrets.apiKeyValue(seedOf(r))}`,
  (r) => `Authorization: Bearer ${secrets.bearerToken(seedOf(r))}`,
  (r) => `Cookie: sid=${fixture(20, B62, seedOf(r))}; theme=dark`,
  (r) => secrets.pem('PRIVATE KEY', seedOf(r)),
  (r) => `postgres://svc:${fixture(10, B62, seedOf(r))}@db.contoso.example:5432/app`,
  (r) => `Server=tcp:db.example.net;Password=${fixture(12, B62, seedOf(r))};Encrypt=yes`,
  (r) => `AccountKey=${secrets.storageAccountKey(seedOf(r))}`,
  (r) => `${fixture(2 + r.int(8), 'abcdefghijklmnopqrstuvwxyz', seedOf(r))}@${r.pick(DOMAINS)}`,
  (r) =>
    `${fixture(3, 'abcdefghijklmnopqrstuvwxyz', seedOf(r))}.${fixture(4, 'abcdefghijklmnopqrstuvwxyz', seedOf(r))}@mail.${r.pick(TLDS)}`,
  (r) => [r.int(256), r.int(256), r.int(256), r.int(256)].join('.'),
  (r) => `${[10, 192, 8, 203, 172][r.int(5)]}.${r.int(256)}.${r.int(256)}.${1 + r.int(254)}`,
  (r) => `+1 (425) 555-${String(r.int(10000)).padStart(4, '0')}`,
  (r) => `+44 20 7946 ${String(r.int(10000)).padStart(4, '0')}`,
  (r) => `425-555-${String(r.int(10000)).padStart(4, '0')}`,
  (r) => fixture(1 + r.int(24), B62, seedOf(r)),
  (r) => fixture(30 + r.int(30), URLSAFE, seedOf(r)),
];

function fragment(random: Rng): string {
  const roll = random.next();
  if (roll < 0.45) return random.pick(KEYWORDS);
  return random.pick(composed)(random);
}

/** A text of 1..14 fragments glued with random separators; printable ASCII, tab, LF and CR only. */
export function makeText(seed: number): string {
  const random = rng(seed);
  const count = 1 + random.int(14);
  let text = '';
  for (let i = 0; i < count; i += 1) {
    text += fragment(random);
    text += random.pick(SEPARATORS);
  }
  return text;
}

/** JSON-like record that mixes secret-named keys, free text, nesting and non-string leaves. */
export function makeRecord(seed: number): Record<string, unknown> {
  const random = rng(seed);
  const text = (): string => makeText(seedOf(random));
  return {
    id: `evt_${seed}`,
    title: text(),
    password: fixture(10, B62, seedOf(random)),
    count: random.int(100),
    flag: random.next() < 0.5,
    nothing: null,
    nested: {
      apiKey: random.next() < 0.5 ? fixture(24, B62, seedOf(random)) : '',
      note: text(),
      items: [text(), { token: fixture(16, B62, seedOf(random)), label: text() }, 42],
    },
    tags: [text(), text()],
  };
}

/** Tenant-style patterns used by the corpus: ticket ids with a trailing boundary and an alternation. */
export const CORPUS_CUSTOM_PATTERNS = [
  { name: 'account', pattern: 'ACME-\\d{4}' },
  { name: 'ticket', pattern: '[A-Z]{3}-\\d{3}' },
  { name: 'ref', pattern: '\\bREF\\d+\\b' },
  { name: 'code', pattern: '(?:XYZ|QRS)-9' },
] as const;

const CUSTOM_FRAGMENTS = [
  'ACME-1234',
  'ACME-12',
  'CUS-123',
  'REF42',
  'REF42x',
  'XYZ-9',
  'QRS-9 and QRS-90',
  'ticket TKT-555 closed',
];

/** Like `makeText`, with a few tokens the custom patterns above are meant to catch. */
export function makeCustomText(seed: number): string {
  const random = rng(seed);
  const base = makeText(seed);
  const parts = [base];
  for (let i = 0; i < 1 + random.int(3); i += 1) parts.push(random.pick(CUSTOM_FRAGMENTS));
  return parts.join(random.pick(SEPARATORS) || ' ');
}
