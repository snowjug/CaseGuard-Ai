const inspectSymbol = Symbol.for('nodejs.util.inspect.custom');

export const REDACTED = '[redacted]';

/**
 * Holds a secret value so that logging or serialising the configuration can never leak it. The only
 * way to read the value is the explicit `reveal()` call at the point of use.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** Returns the raw secret. Call only where the value is handed to the system that needs it. */
  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [inspectSymbol](): string {
    return `Secret(${REDACTED})`;
  }
}

export const isSecret = (value: unknown): value is Secret => value instanceof Secret;

const CONNECTION_USERINFO = /(:\/\/[^\s:/@]+):[^\s@/]*@/g;
const SECRET_QUERY =
  /([?&;](?:password|pwd|sig|key|token|accountkey|sharedaccesskey)=)[^&;\s"']*/gi;

/** Masks passwords, SAS signatures and key-like query values in any text that may contain a URL. */
export function redactSecretsInText(text: string): string {
  return text
    .replace(CONNECTION_USERINFO, `$1:${REDACTED}@`)
    .replace(SECRET_QUERY, `$1${REDACTED}`);
}
