import { formatDateTimeUtc } from '@caseguard/ui';

/**
 * `9 Mar 2026, 09:30 UTC`, with seconds only when the instant has some: a boundary of `09:40:59` is never shown as
 * `09:41`, which would name a moment that includes an event it does not.
 */
export function formatInstant(iso: string): string {
  const ms = Date.parse(iso);
  return formatDateTimeUtc(iso, {
    seconds: Number.isFinite(ms) && new Date(ms).getUTCSeconds() !== 0,
  });
}
