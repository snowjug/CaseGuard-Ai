export const toMs = (iso: string): number => Date.parse(iso);

export const isoFromMs = (ms: number): string => new Date(ms).toISOString();

export function minutesBetween(fromIso: string, toIso: string): number {
  return (toMs(toIso) - toMs(fromIso)) / 60_000;
}

export function addMinutes(iso: string, minutes: number): string {
  return isoFromMs(toMs(iso) + minutes * 60_000);
}

export const compareIso = (a: string, b: string): number => toMs(a) - toMs(b);

/** Human-readable duration such as "2 d 3 h" or "45 min". */
export function formatDuration(minutes: number): string {
  const m = Math.round(Math.abs(minutes));
  if (m < 60) return `${m} min`;
  if (m < 60 * 48) {
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem === 0 ? `${h} h` : `${h} h ${rem} min`;
  }
  const d = Math.floor(m / 1440);
  const h = Math.round((m % 1440) / 60);
  return h === 0 ? `${d} d` : `${d} d ${h} h`;
}

/** UTC time of day for compact labels, e.g. "09:41 UTC". */
export function formatUtcTime(iso: string): string {
  return `${iso.slice(11, 16)} UTC`;
}

export function formatUtcStamp(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
