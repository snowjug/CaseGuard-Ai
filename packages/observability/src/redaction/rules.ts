/** Placeholder that replaces any value removed by key-based or pattern-based redaction. */
export const REDACTED = '[REDACTED]';

/** Prefix shared by every placeholder; rules use it to avoid re-redacting (keeps redaction idempotent). */
const PLACEHOLDER_GUARD = String.raw`(?!\[REDACTED)`;

export interface TextRule {
  readonly id: string;
  /** PII rules can be switched off by `pii: false`; credential rules are always on. */
  readonly pii: boolean;
  /** Global regex. Every pattern is bounded or anchored so scanning stays linear on hostile input. */
  readonly pattern: RegExp;
  /** Returns the replacement; returning the match unchanged means "not a real hit". */
  readonly replace: (match: string, groups: readonly (string | undefined)[]) => string;
}

const tag = (id: string): string => `[REDACTED:${id}]`;

// ---- credential-bearing field names inside free text -------------------------------------------

const STRONG_WORDS = String.raw`(?:pass(?:word|wd|phrase)|secret|credential|cookie|authorization|(?:api|private|access|account|signing|encryption|master|subscription|instrumentation|license)[ _-]?key|connection[ _-]?string|conn[ _-]?str|(?:access|refresh|id|auth|bearer|session|csrf|xsrf|sas|api|bot|oauth)[ _-]?token|session[ _-]?id)`;
/** Strong words match anywhere ("dbpassword") and may carry a short suffix ("password_hash"). */
const STRONG_KEY = String.raw`${STRONG_WORDS}[A-Za-z0-9_.-]{0,24}`;
/** Ambiguous words need a left boundary so "design" or "tsig" never match `sig`. */
const WEAK_KEY = String.raw`(?<![A-Za-z0-9])(?:token|pwd|sig|sas|jwt|signature|dsn)`;
const ASSIGNMENT_OPERATOR = String.raw`(\\*["']?[ \t]*[:=][ \t]*)`;
const AUTH_SCHEME_PREFIX = String.raw`(?:(?:Bearer|Basic|Digest|Negotiate|NTLM|SharedKeyLite|SharedKey|Token)[ \t]+)`;
/** Matches (and therefore skips) values that are already placeholders, even behind quotes or escapes. */
const VALUE_GUARD = String.raw`(?!\\*["']?\[REDACTED)`;
const UNQUOTED_CHAR = String.raw`[^\s"'<>,;&)\]}]`;
/**
 * A dangling label (`AccountKey= x-api-key: <secret>`, `password: Authorization: Bearer <token>`)
 * belongs to the value: without this the label would be taken as the whole value and the secret
 * behind it would survive.
 */
const DANGLING_LABELS = String.raw`(?:${UNQUOTED_CHAR}*[:=][ \t]+${AUTH_SCHEME_PREFIX}?)*`;
// Quoted values keep their closing quote optional so an unterminated quote can never fail (and
// backtrack) after the key matched: that keeps the whole scan linear.
const ASSIGNMENT_VALUE = String.raw`${VALUE_GUARD}(\\*"(?:[^"\\\r\n]|\\.)*"?|\\*'(?:[^'\\\r\n]|\\.)*'?|${AUTH_SCHEME_PREFIX}?${PLACEHOLDER_GUARD}${DANGLING_LABELS}${PLACEHOLDER_GUARD}${UNQUOTED_CHAR}+)`;
const SECRET_ASSIGNMENT = new RegExp(
  `(${STRONG_KEY}|${WEAK_KEY})${ASSIGNMENT_OPERATOR}${ASSIGNMENT_VALUE}`,
  'gi',
);

const QUOTED_VALUE_OPENING = /^(\\*)(["'])/;

function redactAssignedValue(value: string): string {
  const opening = QUOTED_VALUE_OPENING.exec(value);
  if (opening === null) return REDACTED;
  const slashes = opening[1] ?? '';
  const quote = opening[2] ?? '"';
  const body = value.slice(slashes.length + 1);
  return `${slashes}${quote}${REDACTED}${body.endsWith(quote) ? quote : ''}`;
}

// ---- token and key shapes ----------------------------------------------------------------------

const PRIVATE_KEY =
  /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----(?:(?!-----)(?:[A-Za-z0-9+/=\s:,.-]|\\[nrt])){0,16384}(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----)?/g;

const COOKIE_HEADER = new RegExp(
  // The guard sits before the optional whitespace: placed after it, backtracking into the space would defeat it.
  String.raw`\b(Set-Cookie|Cookie)([ \t]*:)(?![ \t]*\[REDACTED)([ \t]*)[^\r\n]+`,
  'gi',
);

// JWS and JWE compact serialisations: header (always `eyJ`, base64url of `{"`) plus 2-4 segments.
// The left boundary makes each base64url run start at most one scan, which keeps this linear.
const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*){2,4}/g;

const URL_CREDENTIALS = new RegExp(
  String.raw`\b([A-Za-z][A-Za-z0-9+.-]{1,20}:\/\/)${PLACEHOLDER_GUARD}[^\s/?#"'<>]{1,512}@`,
  'g',
);

const AUTH_SCHEME =
  /\b(Bearer|Basic|Digest|Negotiate|NTLM|SharedKeyLite|SharedKey)[ \t]+([A-Za-z0-9._~+/-]{4,}={0,2})/gi;

/** Plain words that follow "Basic" or "Bearer" in prose must not be mistaken for credentials. */
function looksLikeCredential(token: string): boolean {
  return (
    token.length >= 20 ||
    /[0-9._~+/=-]/.test(token) ||
    (token.length >= 12 && /[a-z]/.test(token) && /[A-Z]/.test(token))
  );
}

const PROVIDER_TOKENS = new RegExp(
  String.raw`(?<![A-Za-z0-9_-])(?:` +
    [
      String.raw`gh[pousr]_[A-Za-z0-9]{36,255}`,
      String.raw`github_pat_[A-Za-z0-9_]{22,255}`,
      String.raw`(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}`,
      String.raw`xox[abposr]-[A-Za-z0-9-]{10,}`,
      String.raw`[sr]k_(?:live|test)_[A-Za-z0-9]{16,}`,
      String.raw`whsec_[A-Za-z0-9]{16,}`,
      String.raw`AIza[0-9A-Za-z_-]{35}`,
      String.raw`npm_[A-Za-z0-9]{36}`,
      String.raw`sk-(?:proj-|ant-|svcacct-)?[A-Za-z0-9_-]{20,}`,
      String.raw`SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}`,
      String.raw`glpat-[A-Za-z0-9_-]{20,}`,
      String.raw`[A-Za-z0-9_~.-]{3}\dQ~[A-Za-z0-9_~.-]{31,34}`,
    ].join('|') +
    String.raw`)`,
  'g',
);

/** 64-byte storage account keys: 86 base64 characters plus `==`. */
const STORAGE_ACCOUNT_KEY = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{86}==(?![A-Za-z0-9+/=])/g;

// ---- personal data -----------------------------------------------------------------------------

const EMAIL =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.){1,5}[A-Za-z]{2,24}/g;
const US_SSN = /(?<![0-9-])\d{3}-\d{2}-\d{4}(?![0-9-])/g;
const PAYMENT_CARD = /(?<![0-9-])(?:\d[ -]?){12,18}\d(?![0-9-])/g;
const CARD_ISSUER_PREFIX = /^(?:4|5[1-5]|2[2-7]|3[47]|6011|65|35)/;

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = digits.charCodeAt(i) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

function isPaymentCard(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '');
  return (
    digits.length >= 13 &&
    digits.length <= 19 &&
    CARD_ISSUER_PREFIX.test(digits) &&
    passesLuhn(digits)
  );
}

// Usernames inside file paths (stack traces, ENOENT messages) identify a person.
const WINDOWS_USER_PATH = new RegExp(
  String.raw`\b([A-Za-z]:[\\/]Users[\\/])${PLACEHOLDER_GUARD}[^\\/\s"'<>|:*?]+`,
  'gi',
);
const POSIX_USER_PATH = new RegExp(
  String.raw`(?<![A-Za-z0-9_.-])(\/(?:home|Users)\/)${PLACEHOLDER_GUARD}[^/\s"'<>]+`,
  'g',
);

const first = (groups: readonly (string | undefined)[]): string => groups[0] ?? '';

/**
 * Ordered pattern rules. Order matters: key-anchored assignments run first so a whole
 * `Authorization: Bearer <jwt>` collapses to one placeholder, then token shapes, then personal data.
 */
export const TEXT_RULES: readonly TextRule[] = [
  { id: 'private-key', pii: false, pattern: PRIVATE_KEY, replace: () => tag('private-key') },
  {
    id: 'cookie-header',
    pii: false,
    pattern: COOKIE_HEADER,
    replace: (_match, groups) => `${first(groups)}${groups[1] ?? ''}${groups[2] ?? ''}${REDACTED}`,
  },
  {
    id: 'secret-assignment',
    pii: false,
    pattern: SECRET_ASSIGNMENT,
    replace: (_match, groups) =>
      `${first(groups)}${groups[1] ?? ''}${redactAssignedValue(groups[2] ?? '')}`,
  },
  { id: 'jwt', pii: false, pattern: JWT, replace: () => tag('jwt') },
  {
    id: 'url-credentials',
    pii: false,
    pattern: URL_CREDENTIALS,
    replace: (_match, groups) => `${first(groups)}${REDACTED}@`,
  },
  {
    id: 'auth-scheme',
    pii: false,
    pattern: AUTH_SCHEME,
    replace: (match, groups) =>
      looksLikeCredential(groups[1] ?? '') ? `${first(groups)} ${tag('auth')}` : match,
  },
  { id: 'provider-token', pii: false, pattern: PROVIDER_TOKENS, replace: () => tag('token') },
  { id: 'storage-key', pii: false, pattern: STORAGE_ACCOUNT_KEY, replace: () => tag('key') },
  { id: 'email', pii: true, pattern: EMAIL, replace: () => tag('email') },
  { id: 'ssn', pii: true, pattern: US_SSN, replace: () => tag('ssn') },
  {
    id: 'payment-card',
    pii: true,
    pattern: PAYMENT_CARD,
    replace: (match) => (isPaymentCard(match) ? tag('card') : match),
  },
  {
    id: 'user-path',
    pii: true,
    pattern: WINDOWS_USER_PATH,
    replace: (_match, groups) => `${first(groups)}${REDACTED}`,
  },
  {
    id: 'user-path',
    pii: true,
    pattern: POSIX_USER_PATH,
    replace: (_match, groups) => `${first(groups)}${REDACTED}`,
  },
];

/** Positional capture groups from a `String.replace` callback (everything before the numeric offset). */
function captureGroups(args: readonly unknown[]): (string | undefined)[] {
  const groups: (string | undefined)[] = [];
  for (const arg of args) {
    if (typeof arg === 'number') break;
    groups.push(typeof arg === 'string' ? arg : undefined);
  }
  return groups;
}

export interface ApplyRulesOptions {
  readonly pii: boolean;
  /** Called once per replaced match with the rule id (for "secrets reached the logger" signals). */
  readonly onHit?: ((ruleId: string) => void) | undefined;
}

const MIN_SCANNABLE_LENGTH = 5;
/** Shortest credential shape any rule can match without punctuation (a Slack token, 15 characters). */
const MIN_PLAIN_TOKEN_LENGTH = 15;
/** SSNs have nine digits and payment cards thirteen; fewer digits cannot match either. */
const MIN_PII_DIGITS = 9;

/**
 * Cheap pre-check. Every rule needs `: = @ . / \` or whitespace, a token-length run, or nine digits,
 * so a short string of letters, digits, `_` and `-` can be skipped without running 14 regexes.
 */
function mayContainSensitiveText(input: string): boolean {
  if (input.length >= MIN_PLAIN_TOKEN_LENGTH) return true;
  let digits = 0;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code >= 48 && code <= 57) {
      digits += 1;
    } else if (
      code <= 32 ||
      code === 58 || // :
      code === 61 || // =
      code === 64 || // @
      code === 46 || // .
      code === 47 || // /
      code === 92 // \
    ) {
      return true;
    }
  }
  return digits >= MIN_PII_DIGITS;
}

/** Runs every rule over `input`. Pure and synchronous; never throws on any string. */
export function applyTextRules(input: string, options: ApplyRulesOptions): string {
  if (input.length < MIN_SCANNABLE_LENGTH || !mayContainSensitiveText(input)) return input;
  let text = input;
  for (const rule of TEXT_RULES) {
    if (rule.pii && !options.pii) continue;
    text = text.replace(rule.pattern, (match: string, ...args: unknown[]) => {
      const replacement = rule.replace(match, captureGroups(args));
      if (replacement !== match) options.onHit?.(rule.id);
      return replacement;
    });
  }
  return text;
}
