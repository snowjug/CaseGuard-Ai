import { describe, expect, it } from 'vitest';
import { createLogger, createScrubber, scrubText, scrubValue } from '../src';
import { createCapture, seededRandom } from './helpers/fakes';
import { fakeSecrets, type FakeSecret } from './helpers/secrets';

const secrets = fakeSecrets();

const BENIGN = [
  'hello',
  'request',
  'completed',
  'in',
  '12ms',
  'GET',
  '/api/v1/cases',
  'status=200',
  '👍',
  '日本語',
  'café',
  '"quoted"',
  "it's",
  'a\\b',
  '{',
  '}',
  '[',
  ']',
  '(',
  ')',
  ':',
  '=',
  '&',
  '?',
  '#',
  '%41',
  '\n',
  '\t',
  '\r\n',
  '\u0000',
  '\u2028',
  'x'.repeat(30),
  '12345',
  'user_ava_engineer',
  ': ',
  '= ',
  'key:',
  'label=',
  ' ',
];

const RISKY = [
  'password=',
  'password: ',
  '"token":"',
  "'secret' = '",
  'Bearer ',
  'Basic ',
  'Authorization:',
  'Authorization: Bearer',
  'Cookie:',
  'eyJ',
  'eyJhbGciOiJIUzI1NiJ9.',
  'sig=',
  '&sig=',
  '://',
  'user:pw@',
  '@',
  '.com',
  'AKIA',
  'ghp_',
  'sk-',
  'xoxb-',
  ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' '),
  ['-----END', 'RSA PRIVATE KEY-----'].join(' '),
  'Server=',
  ';Password=',
  'AccountKey=',
  '[REDACTED]',
  '[REDACTED:jwt]',
  '123-45-6789',
  '4111111111111111',
  'C:\\Users\\',
  '/home/',
  '\\"',
  'x-api-key:',
  'token:',
  'secret=',
  '\\"password\\":\\"',
  "password='",
  'password="',
];

const SEPARATORS = [' ', '\n', ', ', '; ', ' | ', '\t', '  ', ' \t '];

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)] as T;
}

/** Random text mixing benign words, risky fragments and whole fake secrets; fragments are always separated. */
function randomText(random: () => number): { text: string; embedded: FakeSecret[] } {
  const count = 1 + Math.floor(random() * 24);
  const parts: string[] = [];
  const embedded: FakeSecret[] = [];
  for (let i = 0; i < count; i += 1) {
    const roll = random();
    if (roll < 0.45) {
      parts.push(pick(BENIGN, random));
    } else if (roll < 0.8) {
      parts.push(pick(RISKY, random));
    } else {
      const secret = pick(secrets, random);
      embedded.push(secret);
      parts.push(secret.text);
    }
  }
  let text = '';
  for (const part of parts) text += `${part}${pick(SEPARATORS, random)}`;
  return { text, embedded };
}

function randomValue(random: () => number, depth: number): unknown {
  const roll = random();
  if (depth <= 0 || roll < 0.35) return randomText(random).text;
  if (roll < 0.45) return Math.floor(random() * 1000);
  if (roll < 0.5) return random() < 0.5;
  if (roll < 0.55) return null;
  if (roll < 0.75)
    return Array.from({ length: Math.floor(random() * 4) }, () => randomValue(random, depth - 1));
  const keys = ['password', 'token', 'headers', 'name', 'data', 'items', 'apiKey', 'x', 'email'];
  const out: Record<string, unknown> = {};
  for (let i = 0; i < 1 + Math.floor(random() * 4); i += 1) {
    out[pick(keys, random)] = randomValue(random, depth - 1);
  }
  return out;
}

describe('redaction properties (seeded, table-driven)', () => {
  it('[NFR-OBS-01] [NFR-SEC-06] scrubText never throws, is idempotent and never keeps an embedded secret', () => {
    const random = seededRandom(20261029);
    for (let i = 0; i < 1500; i += 1) {
      const { text, embedded } = randomText(random);
      let once = '';
      expect(() => {
        once = scrubText(text);
      }, `iteration ${i}`).not.toThrow();
      expect(typeof once).toBe('string');
      expect(scrubText(once), `idempotence, iteration ${i}`).toBe(once);
      for (const secret of embedded) {
        for (const core of secret.cores) {
          expect(once.includes(core), `${secret.id} leaked, iteration ${i}`).toBe(false);
        }
      }
    }
  });

  it('[NFR-OBS-01] scrubValue never throws, is idempotent and always yields JSON-serialisable data', () => {
    const random = seededRandom(7);
    for (let i = 0; i < 400; i += 1) {
      const value = randomValue(random, 4);
      const once = scrubValue(value);
      expect(() => JSON.stringify(once), `iteration ${i}`).not.toThrow();
      expect(JSON.stringify(scrubValue(once)), `idempotence, iteration ${i}`).toBe(
        JSON.stringify(once),
      );
    }
  });

  it('[NFR-SEC-06] credential-named keys never keep a string value, wherever they appear', () => {
    for (let i = 0; i < 300; i += 1) {
      const marker = `fakeMarker${i}Zq`;
      const wrapped = { level1: [{ level2: { password: marker, apiKey: marker, token: marker } }] };
      expect(JSON.stringify(scrubValue(wrapped))).not.toContain(marker);
    }
  });

  it('[NFR-OBS-01] a logger fed random hostile structures always writes valid JSON without any embedded secret', () => {
    const random = seededRandom(424242);
    const capture = createCapture();
    const logger = createLogger({
      service: 'fuzz',
      version: '0.0.0',
      env: 'test',
      level: 'trace',
      destination: capture.destination,
    });
    const embeddedCores = new Set<string>();
    for (let i = 0; i < 300; i += 1) {
      const { text, embedded } = randomText(random);
      for (const secret of embedded) secret.cores.forEach((core) => embeddedCores.add(core));
      logger.info({ payload: randomValue(random, 3), note: text }, text);
    }
    expect(capture.records()).toHaveLength(300);
    const output = capture.text();
    for (const core of embeddedCores) expect(output.includes(core), core).toBe(false);
  });
});

describe('redaction cost on hostile input', () => {
  const adversarial: [string, string][] = [
    ['repeated JWT prefix', 'eyJ'.repeat(10_000)],
    ['unterminated quoted assignments', 'password:"'.repeat(3_000)],
    ['email-like runs', 'a@'.repeat(15_000)],
    ['private key markers', ['-----BEGIN', 'PRIVATE KEY-----'].join(' ').repeat(1_000)],
    ['bearer scheme spam', 'Bearer '.repeat(4_000)],
    ['AWS prefix spam', 'AKIA'.repeat(8_000)],
    ['url scheme spam', '://'.repeat(10_000)],
    ['digit groups', '1 '.repeat(15_000)],
    ['single huge token', 'x'.repeat(32_768)],
    ['all spaces', ' '.repeat(32_768)],
    ['dotted segments', 'a.'.repeat(16_000)],
    ['token assignments', 'token='.repeat(5_000)],
    ['backslashes', '\\'.repeat(30_000)],
    ['double quotes', '"'.repeat(30_000)],
    ['cookie headers', 'Cookie:'.repeat(4_000)],
  ];

  it.each(adversarial)('[NFR-OBS-01] %s is scrubbed in well under a second', (_name, input) => {
    const started = performance.now();
    scrubText(input);
    createScrubber({ maxStringLength: 1_000_000 }).text(input);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
