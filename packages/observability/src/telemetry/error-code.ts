const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/**
 * A short identifier describing `error` (its `code`, else its `name`), or `fallback`. It never returns
 * the message: messages of failed network and SDK calls can echo connection strings and keys, so
 * telemetry code reports this identifier and nothing else.
 */
export function safeErrorCode(error: unknown, fallback = 'unknown'): string {
  if (typeof error !== 'object' || error === null) return fallback;
  for (const key of ['code', 'name'] as const) {
    let value: unknown;
    try {
      value = (error as Record<string, unknown>)[key];
    } catch {
      // A hostile getter: the identifier is simply unknown, which is what the fallback says.
      continue;
    }
    if (typeof value === 'string' && SAFE_CODE.test(value)) return value;
  }
  return fallback;
}
