/** How a field name should be treated when it appears as an object key in a log record or span. */
export type KeyClass = 'secret' | 'pii' | 'none';

/** Substrings (of the lower-cased, alphanumeric-only key) that always mark a credential. */
const SECRET_CONTAINS: readonly string[] = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'authorization',
  'cookie',
  'credential',
  'connectionstring',
  'connstr',
  'sessionid',
  'sessionkey',
  'csrf',
  'xsrf',
  'privatekey',
  'accesskey',
  'accountkey',
  'apikey',
  'signingkey',
  'encryptionkey',
  'masterkey',
  'subscriptionkey',
  'instrumentationkey',
  'licensekey',
  'bearer',
];

/** Singular "token" only: `promptTokens`, `totalTokens` and `tokenCount` are counters, not credentials. */
const SECRET_ENDS_WITH: readonly string[] = ['token', 'signature', 'jwt', 'pwd'];
const SECRET_EXACT: ReadonlySet<string> = new Set([
  'sig',
  'sas',
  'dsn',
  'otp',
  'pin',
  'tokenvalue',
  'tokenstring',
]);

const PII_CONTAINS: readonly string[] = [
  'email',
  'phonenumber',
  'telephone',
  'mobilenumber',
  'firstname',
  'lastname',
  'fullname',
  'givenname',
  'familyname',
  'surname',
  'displayname',
  'dateofbirth',
  'birthdate',
  'creditcard',
  'cardnumber',
  'socialsecurity',
  'passport',
  'driverlicense',
  'homeaddress',
  'streetaddress',
  'postaladdress',
  'transcript',
  'casecontent',
  'casetext',
  'casenotes',
  'rawtext',
  'requestbody',
  'responsebody',
  'completiontext',
];
/** Short words are matched at the end only: `ssn` would otherwise match inside "classname". */
const PII_ENDS_WITH: readonly string[] = ['prompt', 'ssn', 'cvv', 'cvc', 'iban', 'dob'];
const PII_EXACT: ReadonlySet<string> = new Set([
  'phone',
  'mobile',
  'address',
  'completion',
  'username',
  'upn',
  'preferredusername',
]);

/** Header names whose *next* array element is a credential (flat `rawHeaders` and `[name, value]` tuples). */
const SECRET_HEADER_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'xapikey',
  'apikey',
  'xauthtoken',
  'xcsrftoken',
  'xxsrftoken',
  'ocpapimsubscriptionkey',
]);

const MAX_KEY_LENGTH = 256;
const MAX_CACHE_ENTRIES = 4096;

function normalizeKey(key: string): string {
  const bounded = key.length > MAX_KEY_LENGTH ? key.slice(0, MAX_KEY_LENGTH) : key;
  return bounded.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function includesAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

function endsWithAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.endsWith(needle));
}

function classifyNormalized(normalized: string, extra: ReadonlySet<string>): KeyClass {
  if (normalized.length === 0) return 'none';
  if (
    extra.has(normalized) ||
    SECRET_EXACT.has(normalized) ||
    endsWithAny(normalized, SECRET_ENDS_WITH) ||
    includesAny(normalized, SECRET_CONTAINS)
  ) {
    return 'secret';
  }
  if (
    PII_EXACT.has(normalized) ||
    endsWithAny(normalized, PII_ENDS_WITH) ||
    includesAny(normalized, PII_CONTAINS)
  ) {
    return 'pii';
  }
  return 'none';
}

/**
 * Builds a memoising key classifier. The memo lives in the closure (bounded), so two scrubbers never
 * share state. `extraSecretKeys` are matched exactly after normalisation (case, `-`, `_`, `.` ignored).
 */
export function createKeyClassifier(
  extraSecretKeys: readonly string[] = [],
): (key: string) => KeyClass {
  const extra = new Set(extraSecretKeys.map(normalizeKey).filter((key) => key.length > 0));
  const memo = new Map<string, KeyClass>();
  return (key) => {
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const result = classifyNormalized(normalizeKey(key), extra);
    if (memo.size >= MAX_CACHE_ENTRIES) memo.clear();
    memo.set(key, result);
    return result;
  };
}

const NO_EXTRA_KEYS: ReadonlySet<string> = new Set();

/** Classifies a single field name without memoisation (pure; use `createKeyClassifier` on hot paths). */
export function classifyKey(key: string): KeyClass {
  return classifyNormalized(normalizeKey(key), NO_EXTRA_KEYS);
}

/** True when a field name denotes a credential or personal data and its value must not be recorded. */
export function isSensitiveKey(key: string): boolean {
  return classifyKey(key) !== 'none';
}

/** True for HTTP header names whose value is a credential (case and punctuation are ignored). */
export function isSecretHeaderName(name: string): boolean {
  return SECRET_HEADER_NAMES.has(normalizeKey(name));
}
