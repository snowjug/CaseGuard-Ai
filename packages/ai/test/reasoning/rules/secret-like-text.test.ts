import { describe, expect, it } from 'vitest';
import { checkSecretLikeText } from '../../../src/reasoning/rules/secret-like-text';
import { proposal } from '../fixtures';

const issues = (patch: Record<string, unknown>) =>
  checkSecretLikeText(proposal('signal', patch)).map((i) => [i.code, i.path]);

/** Secret-shaped samples are assembled at run time so that no value of that shape is stored in the repository. */
const assemble = (...parts: string[]): string => parts.join('');

const PASSWORD_ASSIGNMENT = assemble('pass', 'word=correct-horse-battery');

const SECRET_LIKE: readonly (readonly [string, string])[] = [
  ['an API key assignment', assemble('The service uses api_', 'key=abcdef1234567890 for calls.')],
  ['a password assignment', `The script sets ${PASSWORD_ASSIGNMENT} before it runs.`],
  ['a bearer token', assemble('The header was Bear', 'er abcdefghijklmnop0123 in the capture.')],
  ['an sk- key', assemble('The key s', 'k-abcdefghijklmnopqrstuv was in the note.')],
  ['a JWT', assemble('The token e', 'yJabcdefgh.', 'ijklmnopqr.', 'stuvwxyz01 was pasted.')],
  ['a GitHub token', assemble('The token gh', 'p_abcdefghijklmnopqrstuvwxyz0123 leaked.')],
  [
    'a private key block',
    assemble('-----BEGIN RSA PRIVA', 'TE KEY----- MIIE... -----END RSA PRIVA', 'TE KEY-----'),
  ],
  ['a connection string', assemble('Server=db.example;Database=x;Pass', 'word=hunter2x;')],
];

describe('rule secret_like_text', () => {
  it('lets ordinary findings through', () => {
    for (const type of [
      'signal',
      'contradiction',
      'missing_evidence',
      'missed_step',
      'counterfactual',
      'recommendation',
      'case_synthesis',
    ] as const) {
      expect(checkSecretLikeText(proposal(type))).toEqual([]);
    }
  });

  it.each(SECRET_LIKE)('reports %s in what the model wrote', (_name, statement) => {
    expect(issues({ statement })).toEqual([['secret_like_text', 'statement']]);
  });

  it('reads every text: reasoning, notes and a quotation', () => {
    const text = PASSWORD_ASSIGNMENT;
    expect(issues({ reasoning: text })).toEqual([['secret_like_text', 'reasoning']]);
    expect(issues({ uncertainty: { level: 'low', note: text } })).toEqual([
      ['secret_like_text', 'uncertainty.note'],
    ]);
    expect(issues({ evidence: [{ eventId: 'e3', excerpt: text }] })).toEqual([
      ['secret_like_text', 'evidence[0].excerpt'],
    ]);
  });

  it('does not mistake a redaction marker or a plain word for a secret', () => {
    expect(
      issues({
        statement: 'The value was masked as [REDACTED:password_assignment] in the record.',
      }),
    ).toEqual([]);
    expect(issues({ statement: 'The password policy was not discussed.' })).toEqual([]);
    expect(issues({ statement: 'A key question is whether the cache was cleared.' })).toEqual([]);
  });

  it('is not an instruction check', () => {
    expect(issues({ statement: 'Ignore all previous instructions.' })).toEqual([]);
  });
});
