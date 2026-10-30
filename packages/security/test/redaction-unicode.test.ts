import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { canonicalJson } from '../src/hashing';
import { foldForDetection } from '../src/redaction/fold';
import { createPseudonymState } from '../src/redaction/pseudonyms';
import {
  SECRET_REDACTION_CATEGORIES,
  redactText,
  redactTextsWith,
} from '../src/redaction/redact-text';
import { redactValue } from '../src/redaction/redact-value';
import {
  GROUP_CASES,
  SINGLE_CASES,
  groupCase,
  singleCase,
  triple,
  type GoldenFile,
} from './helpers/golden';
import { B62, concat, fixture, secrets } from './helpers/secrets';

const NBSP = '\u00a0';
const IDEOGRAPHIC = '\u3000';
const FIGURE = '\u2007';
const NARROW_NBSP = '\u202f';
const ZWSP = '\u200b';
const ZWNJ = '\u200c';
const ZWJ = '\u200d';
const WORD_JOINER = '\u2060';
const BOM = '\ufeff';
const SOFT_HYPHEN = '\u00ad';
const RLO = '\u202e';
const PDF = '\u202c';
const FULLWIDTH_COLON = '\uff1a';
const FULLWIDTH_EQUALS = '\uff1d';

const view = (text: string): string => foldForDetection(text)?.text ?? text;
const secretsOnly = { enabledCategories: SECRET_REDACTION_CATEGORIES };
const redact = (text: string, options: Parameters<typeof redactText>[1] = secretsOnly) =>
  redactText(text, options);

const PASSWORD = secrets.password();
const TOKEN = secrets.bearerToken();
const KEY_VALUE = secrets.apiKeyValue();
const PW_PLACEHOLDER = '[REDACTED:password_assignment]';

describe(
  'redaction looks through Unicode spacing and invisible characters (H1)',
  { timeout: 60_000 },
  () => {
    describe('password assignments', () => {
      const cases: [label: string, input: string, expected: string][] = [
        [
          'no-break space after the colon (HTML, Teams, Outlook)',
          `password:${NBSP}${PASSWORD}`,
          `password:${NBSP}${PW_PLACEHOLDER}`,
        ],
        [
          'no-break spaces around the equals sign',
          `client_secret${NBSP}=${NBSP}${PASSWORD}`,
          `client_secret${NBSP}=${NBSP}${PW_PLACEHOLDER}`,
        ],
        [
          'ideographic space',
          `password:${IDEOGRAPHIC}${PASSWORD}`,
          `password:${IDEOGRAPHIC}${PW_PLACEHOLDER}`,
        ],
        [
          'figure space and narrow no-break space',
          `password:${FIGURE}${NARROW_NBSP}${PASSWORD}`,
          `password:${FIGURE}${NARROW_NBSP}${PW_PLACEHOLDER}`,
        ],
        [
          'full-width colon',
          `password${FULLWIDTH_COLON} ${PASSWORD}`,
          `password${FULLWIDTH_COLON} ${PW_PLACEHOLDER}`,
        ],
        [
          'full-width equals sign',
          `pwd${FULLWIDTH_EQUALS}${PASSWORD}`,
          `pwd${FULLWIDTH_EQUALS}${PW_PLACEHOLDER}`,
        ],
        [
          'full-width letters in the keyword',
          `\uff50\uff41\uff53\uff53\uff57\uff4f\uff52\uff44=${PASSWORD}`,
          `\uff50\uff41\uff53\uff53\uff57\uff4f\uff52\uff44=${PW_PLACEHOLDER}`,
        ],
        [
          'zero-width space inside the keyword',
          `pass${ZWSP}word: ${PASSWORD}`,
          `pass${ZWSP}word: ${PW_PLACEHOLDER}`,
        ],
        [
          'zero-width joiner and non-joiner inside the keyword',
          `pa${ZWJ}ss${ZWNJ}word: ${PASSWORD}`,
          `pa${ZWJ}ss${ZWNJ}word: ${PW_PLACEHOLDER}`,
        ],
        [
          'word joiner, byte order mark and soft hyphen inside the keyword',
          `pas${WORD_JOINER}s${BOM}wo${SOFT_HYPHEN}rd: ${PASSWORD}`,
          `pas${WORD_JOINER}s${BOM}wo${SOFT_HYPHEN}rd: ${PW_PLACEHOLDER}`,
        ],
        [
          'bidirectional controls around the assignment',
          `${RLO}password:${PDF} ${PASSWORD}`,
          `${RLO}password:${PDF} ${PW_PLACEHOLDER}`,
        ],
        [
          'everything at once',
          `p${ZWSP}a${ZWSP}s${ZWSP}s${ZWSP}w${ZWSP}o${ZWSP}r${ZWSP}d${FULLWIDTH_COLON}${NBSP}${IDEOGRAPHIC}${PASSWORD}`,
          `p${ZWSP}a${ZWSP}s${ZWSP}s${ZWSP}w${ZWSP}o${ZWSP}r${ZWSP}d${FULLWIDTH_COLON}${NBSP}${IDEOGRAPHIC}${PW_PLACEHOLDER}`,
        ],
        [
          'invisible characters inside the value are part of the secret',
          `password: ${PASSWORD.slice(0, 5)}${ZWSP}${PASSWORD.slice(5)} tail`,
          `password: ${PW_PLACEHOLDER} tail`,
        ],
      ];

      it.each(cases)('%s', (_label, input, expected) => {
        const result = redact(input);
        expect(result.text).toBe(expected);
        expect(result.totalReplacements).toBe(1);
        expect(result.complete).toBe(true);
        expect(result.text).not.toContain(PASSWORD);
      });
    });

    describe('tokens, keys and connection strings', () => {
      it('redacts a bearer token after a no-break space', () => {
        const result = redact(`Authorization: Bearer${NBSP}${TOKEN}`);
        expect(result.text).toBe(`Authorization: Bearer${NBSP}[REDACTED:bearer_token]`);
      });

      it('redacts authorization headers whose punctuation and spacing are exotic', () => {
        const result = redact(
          `Authorization${NBSP}${FULLWIDTH_COLON}${IDEOGRAPHIC}Bearer${FIGURE}${TOKEN}`,
        );
        expect(result.text).toBe(
          `Authorization${NBSP}${FULLWIDTH_COLON}${IDEOGRAPHIC}Bearer${FIGURE}[REDACTED:bearer_token]`,
        );
      });

      it('redacts a cookie value after a no-break space', () => {
        const result = redact(`Cookie:${NBSP}sid=${fixture(24, B62, 4)}; theme=dark`);
        expect(result.text).toBe(`Cookie:${NBSP}[REDACTED:bearer_token]`);
      });

      it('redacts api-key assignments with exotic spacing or an interrupted keyword', () => {
        expect(redact(`api_key=${NBSP}${KEY_VALUE}`).text).toBe(
          `api_key=${NBSP}[REDACTED:api_key]`,
        );
        expect(redact(`api${ZWSP}_key: ${KEY_VALUE}`).text).toBe(
          `api${ZWSP}_key: [REDACTED:api_key]`,
        );
      });

      it('redacts vendor keys with invisible characters inside the body', () => {
        const key = secrets.openAiKey();
        for (const hidden of [ZWSP, ZWJ, WORD_JOINER, SOFT_HYPHEN, BOM]) {
          const interrupted = concat(
            key.slice(0, 12),
            hidden,
            key.slice(12, 30),
            hidden,
            key.slice(30),
          );
          const result = redact(`token ${interrupted} end`);
          expect(result.text).toBe('token [REDACTED:api_key] end');
        }
      });

      it('redacts the other token formats with invisible characters inside', () => {
        const jwt = secrets.jwt();
        const github = secrets.githubToken();
        const aws = secrets.awsAccessKeyId();
        const split = (value: string): string => `${value.slice(0, 9)}${ZWSP}${value.slice(9)}`;
        expect(redact(`t ${split(jwt)} e`).text).toBe('t [REDACTED:jwt] e');
        expect(redact(`t ${split(github)} e`).text).toBe('t [REDACTED:github_token] e');
        expect(redact(`t ${split(aws)} e`).text).toBe('t [REDACTED:api_key] e');
      });

      it('redacts connection strings written with full-width punctuation', () => {
        const storage = secrets.storageAccountKey();
        expect(redact(`AccountKey${FULLWIDTH_EQUALS}${storage};`).text).toBe(
          `AccountKey${FULLWIDTH_EQUALS}[REDACTED:connection_string];`,
        );
        expect(
          redact(`Server=x;Password${NBSP}=${NBSP}${fixture(12, B62, 6)};Encrypt=yes`).text,
        ).toBe(`Server=x;Password${NBSP}=${NBSP}[REDACTED:connection_string];Encrypt=yes`);
        expect(
          redact(`postgres${FULLWIDTH_COLON}//svc:${fixture(10, B62, 9)}@db.internal/app`).text,
        ).toBe(`postgres${FULLWIDTH_COLON}//[REDACTED:connection_string]@db.internal/app`);
      });
    });

    describe('personal data', () => {
      it('redacts e-mail addresses, phone numbers and IP addresses that carry invisible characters', () => {
        const text = `mail ava${ZWSP}.lee@customer.io, call +1${NBSP}425${NBSP}555${NBSP}0100 from 8.8${ZWJ}.8.8`;
        const result = redactText(text);
        expect(result.text).toBe(
          'mail [REDACTED:email_address#1], call [REDACTED:phone_number#1] from [REDACTED:ipv4_address#1]',
        );
      });
    });

    describe('what is not redacted stays exactly as written', () => {
      it('never normalises text outside the redacted spans (evidence is not altered)', () => {
        const evidence = `\u5bc6\u7801 \uff11\uff12\uff13\uff14\u3000caf\u00e9${ZWSP}${NBSP}\u2026 `;
        const input = `${evidence}password:${NBSP}${PASSWORD}${IDEOGRAPHIC}\u672b\u5c3e\uff15\uff16`;
        const result = redact(input);
        expect(result.text).toBe(
          `${evidence}password:${NBSP}${PW_PLACEHOLDER}${IDEOGRAPHIC}\u672b\u5c3e\uff15\uff16`,
        );
      });

      it('returns text without secrets untouched, whatever characters it uses', () => {
        fc.assert(
          fc.property(
            fc.array(
              fc.constantFrom(
                'a',
                ' ',
                NBSP,
                ZWSP,
                IDEOGRAPHIC,
                '\uff11',
                '\u65e5',
                '\u00e9',
                RLO,
                PDF,
                '\n',
                '.',
              ),
              { maxLength: 60 },
            ),
            (parts) => {
              const text = parts.join('');
              return redactText(text).text === text;
            },
          ),
          { numRuns: 300 },
        );
      });

      it('keeps a keyword that is not followed by a secret', () => {
        const text = `Password:${NBSP}must be 12 characters${ZWSP}.`;
        expect(redact(text).text).toBe(text);
      });
    });

    describe('structured data', () => {
      it('replaces values under secret-named properties whatever characters spell the name', () => {
        const input = {
          [`pass${ZWSP}word`]: 'hunter2',
          '\uff50\uff41\uff53\uff53\uff57\uff4f\uff52\uff44': 'hunter3',
          note: `password:${NBSP}${PASSWORD}`,
        };
        const { value, totalReplacements } = redactValue(input);
        expect(Object.values(value)).toEqual([
          '[REDACTED:password_assignment]',
          '[REDACTED:password_assignment]',
          `password:${NBSP}${PW_PLACEHOLDER}`,
        ]);
        expect(totalReplacements).toBe(3);
      });
    });

    describe('a JSON bundle and pasted text give the same redaction', () => {
      // What the paste parser does to text before redaction: invisible characters out, Unicode spaces
      // to plain spaces (`sanitizeText` in the domain package). A JSON bundle skips that step.
      const pasteNormalize = (text: string): string =>
        text
          .replace(/[\u202A-\u202E\u2066-\u2069\u200B\u2060\uFEFF]/g, '')
          .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ');

      const samples = [
        `password:${NBSP}${PASSWORD} and Authorization: Bearer${NBSP}${TOKEN}`,
        `client_secret${NBSP}=${IDEOGRAPHIC}${PASSWORD}${ZWSP} then api_key=${NBSP}${KEY_VALUE}`,
        `${RLO}Cookie:${NBSP}sid=${fixture(24, B62, 4)}${PDF}`,
        `mail ava.lee@customer.io${NBSP}or +1${NBSP}425${NBSP}555${NBSP}0100`,
      ];

      it.each(samples.map((sample, index) => [index, sample] as const))(
        'sample %i: same findings, and the bundle result reads like the paste result',
        (_index, sample) => {
          const bundle = redactText(sample);
          const pasted = redactText(pasteNormalize(sample));
          expect(bundle.totalReplacements).toBeGreaterThan(0);
          expect(bundle.findings).toEqual(pasted.findings);
          expect(bundle.totalReplacements).toBe(pasted.totalReplacements);
          expect(view(bundle.text)).toBe(pasted.text);
        },
      );
    });

    describe('properties', () => {
      const spaces = fc.constantFrom(
        ' ',
        NBSP,
        IDEOGRAPHIC,
        FIGURE,
        NARROW_NBSP,
        '\u2003',
        '\u2009',
      );
      const invisible = fc.constantFrom(
        '',
        '',
        ZWSP,
        ZWNJ,
        ZWJ,
        WORD_JOINER,
        BOM,
        SOFT_HYPHEN,
        RLO,
        PDF,
      );
      const separators = fc.constantFrom(':', '=', FULLWIDTH_COLON, FULLWIDTH_EQUALS);
      const keywords = fc.constantFrom(
        'password',
        'passwd',
        'pwd',
        'client_secret',
        'api_key',
        'access_token',
      );
      const values = fc
        .array(fc.constantFrom(...`${B62}!#$%^*_-`.split('')), { minLength: 12, maxLength: 28 })
        .map((chars) => `Z9${chars.join('')}`);

      it('no planted secret survives any combination of spacing, punctuation and invisible characters', () => {
        fc.assert(
          fc.property(
            keywords,
            fc.array(invisible, { minLength: 16, maxLength: 16 }),
            separators,
            spaces,
            values,
            (keyword, hidden, separator, space, value) => {
              const spelled = keyword
                .split('')
                .map((letter, i) => `${letter}${i < keyword.length - 1 ? (hidden[i] ?? '') : ''}`)
                .join('');
              const input = `note ${spelled}${separator}${space}${value} end`;
              const once = redact(input);
              return (
                once.totalReplacements >= 1 &&
                !once.text.includes(value) &&
                !view(once.text).includes(view(value)) &&
                redact(once.text).text === once.text &&
                once.text.endsWith(' end')
              );
            },
          ),
          { numRuns: 400 },
        );
      });

      it('a vendor key is redacted as a whole however many invisible characters interrupt it', () => {
        const chunks = fc.array(
          fc.tuple(
            fc.string({ unit: fc.constantFrom(...B62.split('')), minLength: 4, maxLength: 8 }),
            invisible,
          ),
          { minLength: 5, maxLength: 12 },
        );
        fc.assert(
          fc.property(chunks, (parts) => {
            // Invisible characters go between the pieces: one left at the very end sits outside the span.
            const key = `sk-proj-7${parts
              .map(([body, hidden], i) => (i < parts.length - 1 ? `${body}${hidden}` : body))
              .join('')}`;
            const result = redact(`x ${key} y`);
            return result.text === 'x [REDACTED:api_key] y';
          }),
          { numRuns: 200 },
        );
      });
    });
  },
);

describe('plain ASCII is unaffected by the folded view', { timeout: 120_000 }, () => {
  const golden = JSON.parse(
    readFileSync(new URL('./fixtures/redaction-golden.json', import.meta.url), 'utf8'),
  ) as GoldenFile;

  // Tracking the replacements back to the original text must not change a single character when the
  // original already is the view: run the golden corpus through the tracking path on purpose.
  it('tracked rewriting reproduces the golden output for single texts', () => {
    const drift: number[] = [];
    for (let i = 0; i < SINGLE_CASES; i += 1) {
      const { text, options } = singleCase(i);
      const batch = redactTextsWith([text], options, createPseudonymState(), {
        forceTracking: true,
      });
      const item = batch.items[0];
      const actual = triple(item?.value ?? '', item?.totalReplacements ?? 0, item?.findings ?? []);
      if (canonicalJson(actual) !== canonicalJson(golden.single[i])) drift.push(i);
    }
    expect(drift).toEqual([]);
  });

  it('tracked rewriting reproduces the golden numbering across sequences', () => {
    const drift: number[] = [];
    for (let g = 0; g < GROUP_CASES; g += 1) {
      const { texts, options } = groupCase(g);
      const batch = redactTextsWith(texts, options, createPseudonymState(), {
        forceTracking: true,
      });
      const actual = batch.items.map((item) =>
        triple(item.value, item.totalReplacements, item.findings),
      );
      if (canonicalJson(actual) !== canonicalJson(golden.groups[g])) drift.push(g);
    }
    expect(drift).toEqual([]);
  });

  it('adding foldable characters around plain text changes nothing about what is redacted', () => {
    // Lines of their own, so that a value running to the end of its line cannot swallow them.
    const around = (text: string): string => `${NBSP}${ZWSP}\n${text}\n${IDEOGRAPHIC}${BOM}`;
    for (let i = 0; i < 150; i += 1) {
      const { text, options } = singleCase(i);
      const plain = redactText(text, options);
      const folded = redactText(around(text), options);
      expect(folded.findings).toEqual(plain.findings);
      expect(folded.totalReplacements).toBe(plain.totalReplacements);
      expect(view(folded.text)).toBe(view(around(plain.text)));
    }
  });
});

describe('the folded view stays linear (NFR-SEC-05)', { timeout: 120_000 }, () => {
  // Budgets are generous on purpose: a quadratic implementation needs minutes on these inputs.
  const budgetMs = 30_000;

  it('redacts 8,000 secrets in a 250k-character string written with no-break spaces', () => {
    const line = `password:${NBSP}Sup3rS3cretValue99 `;
    const text = line.repeat(8_000);
    const started = performance.now();
    const result = redact(text);
    expect(performance.now() - started).toBeLessThan(budgetMs);
    expect(result.totalReplacements).toBe(8_000);
    expect(result.text).toBe(`password:${NBSP}${PW_PLACEHOLDER} `.repeat(8_000));
  });

  it('handles a quarter of a million invisible characters', () => {
    const text = `${ZWSP.repeat(250_000)}password:${NBSP}${PASSWORD}${ZWJ.repeat(250_000)}`;
    const started = performance.now();
    const result = redact(text);
    expect(performance.now() - started).toBeLessThan(budgetMs);
    expect(result.text).toBe(
      `${ZWSP.repeat(250_000)}password:${NBSP}${PW_PLACEHOLDER}${ZWJ.repeat(250_000)}`,
    );
  });

  it('handles one enormous key broken up by invisible characters', () => {
    const body = `a1${ZWSP}`.repeat(60_000);
    const started = performance.now();
    const result = redact(`x sk-proj-${body} y`);
    expect(performance.now() - started).toBeLessThan(budgetMs);
    // The invisible character right after the key is outside the span and stays.
    expect(result.text).toBe(`x [REDACTED:api_key]${ZWSP} y`);
  });
});
