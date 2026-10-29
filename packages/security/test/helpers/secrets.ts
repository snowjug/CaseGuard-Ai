/*
 * Secret-shaped test values are assembled at runtime so that no source file contains a literal that
 * looks like a credential (the repository's secret scanner would, rightly, flag it).
 */

export const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const B64 = `${B62}+/`;
export const URLSAFE = `${B62}-_`;
export const UPPER_BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const concat = (...parts: string[]): string => parts.join('');

/** Deterministic high-entropy-looking string over `alphabet` (LCG), guaranteed to mix classes. */
export function fixture(length: number, alphabet: string = B62, seed = 1): string {
  let state = seed >>> 0;
  let out = '';
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out += alphabet.charAt((state >>> 16) % alphabet.length);
  }
  return out;
}

export const secrets = {
  bearerToken: (seed = 3): string => fixture(40, URLSAFE, seed),
  jwt: (seed = 5): string =>
    concat(
      'ey',
      'J',
      fixture(20, URLSAFE, seed),
      '.ey',
      'J',
      fixture(30, URLSAFE, seed + 1),
      '.',
      fixture(43, URLSAFE, seed + 2),
    ),
  githubToken: (seed = 11): string => concat('gh', 'p_', fixture(36, B62, seed)),
  githubPat: (seed = 12): string => concat('github', '_pat_', fixture(40, B62, seed)),
  awsAccessKeyId: (seed = 13): string => concat('AK', 'IA', fixture(16, UPPER_BASE32, seed)),
  openAiKey: (seed = 14): string =>
    concat('sk', '-', fixture(8, B62, seed), '0', fixture(40, B62, seed + 1)),
  googleKey: (seed = 15): string => concat('AI', 'za', fixture(35, URLSAFE, seed)),
  slackToken: (seed = 16): string =>
    concat('xo', 'xb-', fixture(12, '0123456789', seed), '-', fixture(24, B62, seed + 1)),
  stripeKey: (seed = 17): string => concat('sk', '_live_', fixture(26, B62, seed)),
  npmToken: (seed = 18): string => concat('npm', '_', fixture(36, B62, seed)),
  sendGridKey: (seed = 19): string =>
    concat('SG', '.', fixture(22, URLSAFE, seed), '.', fixture(43, URLSAFE, seed + 1)),
  entraClientSecret: (seed = 20): string =>
    concat(fixture(3, B62, seed), '8Q', '~', fixture(34, B62, seed + 1)),
  storageAccountKey: (seed = 21): string => concat(fixture(86, B64, seed), '=='),
  sasSignature: (seed = 22): string => fixture(43, B62, seed) + '%3D',
  password: (seed = 23): string => concat('Hn', fixture(10, B62, seed), '9!'),
  apiKeyValue: (seed = 24): string => concat('K', fixture(31, B62, seed), '7'),
  /** A syntactically complete (but random, never valid) private key block. */
  pem: (label = 'RSA PRIVATE KEY', seed = 25): string => {
    const lines = Array.from({ length: 5 }, (_, i) => fixture(64, B64, seed + i));
    return [`-----BEGIN ${label}-----`, ...lines, `-----END ${label}-----`].join('\n');
  },
};
