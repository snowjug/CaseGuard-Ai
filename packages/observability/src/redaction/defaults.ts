import { createScrubber, type Scrubber, type SerializedError } from './scrubber';
import { sanitizeUrlWith } from './url';

// Stateless apart from a bounded key-classification memo, so sharing one instance is safe.
const defaultScrubber: Scrubber = createScrubber();

/** Scrubs free text with the default rules (credentials, token shapes, connection strings, PII). */
export function scrubText(text: string, scrubber: Scrubber = defaultScrubber): string {
  return scrubber.text(text);
}

/** Deep-clones a value into JSON-safe data with sensitive fields and strings scrubbed. Never throws. */
export function scrubValue(value: unknown, scrubber: Scrubber = defaultScrubber): unknown {
  return scrubber.value(value);
}

/** Serialises an error with scrubbed message, stack and cause chain. */
export function serializeError(
  error: unknown,
  scrubber: Scrubber = defaultScrubber,
): SerializedError {
  return scrubber.error(error);
}

/** Strips credentials, fragments and sensitive query values from a URL. Never throws. */
export function sanitizeUrl(input: string, scrubber: Scrubber = defaultScrubber): string {
  return sanitizeUrlWith(input, (text) => scrubber.text(text));
}
