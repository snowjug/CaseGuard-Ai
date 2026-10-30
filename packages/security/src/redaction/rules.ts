import type { RedactionCategory } from '@caseguard/schemas';
import type { PseudonymCategory, PseudonymState } from './pseudonyms';
import type { Rewriter } from './rewriter';
import { isNonRoutableIpv4, isReservedEmailDomain } from './synthetic';

/*
 * Built-in redaction rules.
 *
 * Every pattern here must stay linear-time on hostile input (NFR-SEC-05): no nested or overlapping
 * unbounded quantifiers, and a `(?<!...)` lookbehind wherever a pattern starts with a character run,
 * so the engine tries each run once instead of from every offset. Heuristic checks run in the
 * replace callback (after a linear match) rather than as lookaheads for the same reason.
 *
 * Every rule must also refuse to match its own placeholder. A single pass is stable for almost all
 * input; `redactInto` re-applies the rules until a pass changes nothing, which makes redaction
 * idempotent by construction.
 */

export type BuiltinCategory = Exclude<RedactionCategory, 'custom'>;

export interface RuleContext {
  readonly state: PseudonymState;
  readonly redactReserved: boolean;
  /** Records one replacement for `category`. */
  hit(category: BuiltinCategory): void;
}

export interface RedactionRule {
  readonly category: BuiltinCategory;
  /** Rewrites `doc` (the detection view of one string) in place through `doc.replace`. */
  apply(doc: Rewriter, context: RuleContext): void;
}

/** Stable placeholder written into redacted text. */
export function placeholderFor(category: RedactionCategory): string {
  return `[REDACTED:${category}]`;
}

// ------------------------------------------------------------------ value heuristics

const STOP_VALUES = new Set(['null', 'none', 'nil', 'undefined', 'true', 'false', 'empty', 'n/a']);
const MASKED_VALUE = /^(?:[*\u2022#.?_-]{3,}|[xX]{3,})$/;

function unquote(value: string): string {
  const first = value.charAt(0);
  return (first === '"' || first === "'") && value.length >= 2 && value.endsWith(first)
    ? value.slice(1, -1)
    : value;
}

/** Variable references, masks and empty values are not secrets, and re-redacting them loses information. */
function isStandIn(raw: string): boolean {
  const value = unquote(raw).trim();
  if (value.length === 0 || STOP_VALUES.has(value.toLowerCase())) return true;
  if (MASKED_VALUE.test(value)) return true;
  if (/^(?:\$|%|\{\{|<)/.test(value) || value.includes('${')) return true;
  return value.startsWith('[REDACTED:');
}

/** Words such as "must" or "expired" after `password:` are prose; anything token-like is not. */
function looksSecretLike(value: string): boolean {
  return (
    value.length >= 10 ||
    /\d/.test(value) ||
    /[^A-Za-z0-9]/.test(value) ||
    (/[a-z]/.test(value) && /[A-Z]/.test(value.slice(1)))
  );
}

function keepQuotes(raw: string, placeholder: string): string {
  const first = raw.charAt(0);
  const quote =
    (first === '"' || first === "'") && raw.length >= 2 && raw.endsWith(first) ? first : '';
  return `${quote}${placeholder}${quote}`;
}

// ------------------------------------------------------------------ rule builders

/** Replaces every match of `patterns` (optionally filtered by `accept`) with the category placeholder. */
function wholeMatchRule(
  category: BuiltinCategory,
  patterns: readonly RegExp[],
  accept?: (match: string) => boolean,
): RedactionRule {
  const placeholder = placeholderFor(category);
  return {
    category,
    apply(doc, context) {
      for (const pattern of patterns) {
        doc.replace(pattern, (match: string) => {
          if (accept && !accept(match)) return match;
          context.hit(category);
          return placeholder;
        });
      }
    },
  };
}

/** Pseudonym placeholder, numbered per distinct value within the shared state. */
function pseudonymFor(context: RuleContext, category: PseudonymCategory, key: string): string {
  const index = context.state.indexFor(category, key);
  return index === null ? placeholderFor(category) : `[REDACTED:${category}#${index}]`;
}

// ------------------------------------------------------------------ private keys

const PEM_COMPLETE =
  /-----BEGIN (?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?-----(?:[^-]|-(?!-{4})){0,20000}?-----END (?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?-----/g;
/** A block cut off before its END line (truncated logs): redact the header and the base64 body. */
const PEM_TRUNCATED =
  /-----BEGIN (?:[A-Z0-9]+ ){0,4}PRIVATE KEY(?: BLOCK)?-----(?:\s*[A-Za-z0-9+/=]{16,})*/g;

// ------------------------------------------------------------------ connection strings

/** `scheme://user:secret@host`: the credentials are replaced, scheme and host stay for diagnosis.
 *
 * The user and password runs never contain a placeholder: a match that spans one would depend on
 * what earlier rules wrote there, and a second pass would then redact differently.
 */
const DSN_CREDENTIALS =
  /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]{1,24}:\/\/)(?!\[REDACTED:)(?:(?!\[REDACTED:)[^\s:@/?#'"<>])*:(?:(?!\[REDACTED:)[^\s/?#'"<>])+@(?=[^\s'"<>@])/g;
/** Keys that only ever appear in connection strings: always a connection-string credential. */
const CONNECTION_SECRET_KEY =
  /(?<![A-Za-z0-9_])((?:AccountKey|SharedAccessKey|SharedAccessSignature|SecretAccessKey|InstrumentationKey)[ \t]*[=:][ \t]*)(?!["']?\[REDACTED:)("[^"\r\n]{1,5000}"|'[^'\r\n]{1,5000}'|[^;\r\n"'\s]+)/gi;
/** `Password=` / `Pwd=` are connection-string credentials only when used like `;Password=x;`. */
const CONNECTION_PASSWORD =
  /(?<![A-Za-z0-9_])((?:Password|Pwd)[ \t]*=[ \t]*)(?!["']?\[REDACTED:)("[^"\r\n]{0,5000}"|'[^'\r\n]{0,5000}'|[^\s;][^;\r\n]*)/gi;

const connectionStringRule: RedactionRule = {
  category: 'connection_string',
  apply(doc, context) {
    const placeholder = placeholderFor('connection_string');
    doc.replaceAfterPrefix(DSN_CREDENTIALS, (_match: string, scheme: string) => {
      context.hit('connection_string');
      return `${scheme}${placeholder}@`;
    });
    doc.replaceAfterPrefix(
      CONNECTION_SECRET_KEY,
      (match: string, prefix: string, value: string) => {
        if (isStandIn(value)) return match;
        context.hit('connection_string');
        return `${prefix}${keepQuotes(value, placeholder)}`;
      },
    );
    doc.replaceAfterPrefix(
      CONNECTION_PASSWORD,
      (match: string, prefix: string, value: string, offset: number, whole: string) => {
        const before = whole.slice(Math.max(0, offset - 24), offset);
        const after = whole.charAt(offset + match.length);
        if (!(/;[ \t]*$/.test(before) || after === ';') || isStandIn(value)) return match;
        context.hit('connection_string');
        return `${prefix}${keepQuotes(value, placeholder)}`;
      },
    );
  },
};

// ------------------------------------------------------------------ bearer tokens and cookies

const BEARER = /\b(Bearer[ \t]+)(?!\[REDACTED:)[A-Za-z0-9\-._~+/]{16,}=*/gi;
const AUTH_HEADER =
  /\b((?:Proxy-)?Authorization[ \t]*[:=][ \t]*["']?(?:Basic|Digest|Negotiate|NTLM|Token|ApiKey|Bearer)[ \t]+)(?!\[REDACTED:)[^\s"',;]{8,}/gi;
// The value must start with a non-space: otherwise `[ \t]*` could give back spaces and let a rule
// re-match the text that follows its own placeholder, which would break idempotency.
const COOKIE_HEADER = /\b((?:Set-)?Cookie[ \t]*:[ \t]*)(?!\[REDACTED:)[^\s][^\r\n]{3,}/gi;

const bearerTokenRule: RedactionRule = {
  category: 'bearer_token',
  apply(doc, context) {
    const placeholder = placeholderFor('bearer_token');
    const withPrefix = (_match: string, prefix: string): string => {
      context.hit('bearer_token');
      return `${prefix}${placeholder}`;
    };
    doc.replaceAfterPrefix(BEARER, withPrefix);
    doc.replaceAfterPrefix(AUTH_HEADER, withPrefix);
    doc.replaceAfterPrefix(COOKIE_HEADER, withPrefix);
  },
};

// ------------------------------------------------------------------ token formats

const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g;
const GITHUB_TOKEN =
  /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})/g;
/** Storage account keys are 64 random bytes: 86 base64 characters plus `==`. */
const STORAGE_KEY = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{86}==(?![A-Za-z0-9+/=])/g;
/** Shared-access-signature signatures in URLs. */
const SAS_SIGNATURE = /([?&;]sig=)(?!\[REDACTED:)[A-Za-z0-9%+/=_-]{20,}/gi;

const azureStorageKeyRule: RedactionRule = {
  category: 'azure_storage_key',
  apply(doc, context) {
    const placeholder = placeholderFor('azure_storage_key');
    doc.replace(STORAGE_KEY, () => {
      context.hit('azure_storage_key');
      return placeholder;
    });
    doc.replaceAfterPrefix(SAS_SIGNATURE, (_match: string, prefix: string) => {
      context.hit('azure_storage_key');
      return `${prefix}${placeholder}`;
    });
  },
};

// ------------------------------------------------------------------ api keys

/** Provider-specific key formats. A `sk-` token must contain a digit (checked in the callback). */
const VENDOR_KEYS: readonly RegExp[] = [
  /(?<![A-Za-z0-9_-])sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g,
  /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /(?<![A-Za-z0-9_])[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9._-])SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9_~.-])[A-Za-z0-9_~.-]{3}\dQ~[A-Za-z0-9_~.-]{31,34}(?![A-Za-z0-9_~-])/g,
];

/**
 * One character of an unquoted value. A value ends at whitespace, quotes and common delimiters, and
 * also right before a placeholder, so a rule can never swallow part of a placeholder written by an
 * earlier rule: that would corrupt it and let a second pass redact again (idempotency).
 */
const VALUE_CHAR = String.raw`(?:(?!\[REDACTED:)[^\s"'<>,;&)\]}])`;

const API_KEY_ASSIGNMENT = new RegExp(
  String.raw`((?:api[_-]?key|apikey|x-api-key|subscription[_-]?key|ocp-apim-subscription-key|access[_-]?key|secret[_-]?key|(?:access|refresh|id|auth|bearer|session)[_-]?token|token)["']?[ \t]*[:=][ \t]*)(?!["']?\[REDACTED:)("[^"\r\n]{1,5000}"|'[^'\r\n]{1,5000}'|${VALUE_CHAR}{8,})`,
  'gi',
);

function looksLikeKeyMaterial(value: string): boolean {
  const bare = unquote(value);
  if (isStandIn(bare)) return false;
  return bare.length >= 12 || (bare.length >= 8 && /\d/.test(bare) && /[A-Za-z]/.test(bare));
}

const apiKeyRule: RedactionRule = {
  category: 'api_key',
  apply(doc, context) {
    const placeholder = placeholderFor('api_key');
    VENDOR_KEYS.forEach((pattern, index) => {
      doc.replace(pattern, (match: string) => {
        // Index 0 is the generic `sk-` shape; real keys always mix digits in.
        if (index === 0 && !/\d/.test(match)) return match;
        context.hit('api_key');
        return placeholder;
      });
    });
    doc.replaceAfterPrefix(API_KEY_ASSIGNMENT, (match: string, prefix: string, value: string) => {
      if (!looksLikeKeyMaterial(value)) return match;
      context.hit('api_key');
      return `${prefix}${keepQuotes(value, placeholder)}`;
    });
  },
};

// ------------------------------------------------------------------ passwords

const PASSWORD_ASSIGNMENT = new RegExp(
  String.raw`((?:password|passwd|passphrase|pwd|(?:client|shared)?[_-]?secret)(?:[_-]?(?:key|value|string|text|phrase))?["']?[ \t]*([:=])[ \t]*)(?!["']?\[REDACTED:)("[^"\r\n]{1,5000}"|'[^'\r\n]{1,5000}'|${VALUE_CHAR}+)`,
  'gi',
);

const passwordRule: RedactionRule = {
  category: 'password_assignment',
  apply(doc, context) {
    const placeholder = placeholderFor('password_assignment');
    doc.replaceAfterPrefix(
      PASSWORD_ASSIGNMENT,
      (match: string, prefix: string, separator: string, value: string) => {
        if (isStandIn(value)) return match;
        const quoted = value.startsWith('"') || value.startsWith("'");
        // `password=...` is a configuration assignment: always redact. `password: ...` in prose
        // only when the value looks like a secret, so "Password: must be 12 characters" survives.
        if (separator === ':' && !quoted && !looksSecretLike(value)) return match;
        context.hit('password_assignment');
        return `${prefix}${keepQuotes(value, placeholder)}`;
      },
    );
  },
};

// ------------------------------------------------------------------ personal data

const EMAIL =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,254}@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/g;

const emailRule: RedactionRule = {
  category: 'email_address',
  apply(doc, context) {
    doc.replace(EMAIL, (match: string) => {
      const domain = match.slice(match.lastIndexOf('@') + 1);
      if (!context.redactReserved && isReservedEmailDomain(domain)) return match;
      context.hit('email_address');
      return pseudonymFor(context, 'email_address', match.toLowerCase());
    });
  },
};

const OCTET = '(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)';
const IPV4 = new RegExp(`(?<![\\w.])${OCTET}(?:\\.${OCTET}){3}(?!\\w|\\.\\d)`, 'g');

const ipv4Rule: RedactionRule = {
  category: 'ipv4_address',
  apply(doc, context) {
    doc.replace(IPV4, (match: string) => {
      const octets = match.split('.').map(Number);
      if (!context.redactReserved && isNonRoutableIpv4(octets)) return match;
      context.hit('ipv4_address');
      return pseudonymFor(context, 'ipv4_address', octets.join('.'));
    });
  },
};

/** `+14255550100`: E.164 without separators (a `+` is required, otherwise any 10 digits would match). */
const PHONE_E164 = /(?<![\w+])\+[1-9]\d{7,14}(?!\d)/;
/** `+44 20 7946 0958`, `+1 (425) 555-0100`, `+91-98765-43210`. Separators are mandatory between groups. */
const PHONE_INTERNATIONAL =
  /(?<![\w+.-])\+\d{1,3}(?:[ .\u00a0-]?\(\d{1,5}\))?(?:[ .\u00a0-]\d{1,6}){1,5}(?!\w)/;
/** `425-555-0100`, `(425) 555-0100`, `1.425.555.0100`: North American numbers with separators. */
const PHONE_NANP =
  /(?<![\w.+-])(?:1[ .\u00a0-])?(?:\([2-9]\d{2}\)[ \u00a0]?|[2-9]\d{2}[ .\u00a0-])[2-9]\d{2}[ .\u00a0-]\d{4}(?!\w|[.-]\d)/;
/** One alternation (not three passes) so pseudonym numbers follow the order of appearance in the text. */
const PHONE = new RegExp(
  [PHONE_E164, PHONE_INTERNATIONAL, PHONE_NANP].map((pattern) => pattern.source).join('|'),
  'g',
);

/** Same person, different formatting: compare digits only, and ignore a North American `1` prefix. */
function phoneKey(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

const phoneRule: RedactionRule = {
  category: 'phone_number',
  apply(doc, context) {
    doc.replace(PHONE, (match: string) => {
      const digits = match.replace(/\D/g, '').length;
      if (digits < 8 || digits > 15) return match;
      context.hit('phone_number');
      return pseudonymFor(context, 'phone_number', phoneKey(match));
    });
  },
};

// ------------------------------------------------------------------ assembly

/** Priority order: containers and structured credentials first, generic key=value rules after. */
export const BUILTIN_RULES: readonly RedactionRule[] = [
  wholeMatchRule('private_key', [PEM_COMPLETE, PEM_TRUNCATED]),
  connectionStringRule,
  bearerTokenRule,
  wholeMatchRule('jwt', [JWT]),
  wholeMatchRule('github_token', [GITHUB_TOKEN]),
  azureStorageKeyRule,
  apiKeyRule,
  passwordRule,
  emailRule,
  ipv4Rule,
  phoneRule,
];
