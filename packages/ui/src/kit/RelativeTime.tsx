'use client';

import { useSyncExternalStore } from 'react';
import { NOT_AVAILABLE, formatDateTimeUtc, formatDateUtc, type DateInput } from '../format';

const MINUTE = 60_000;
const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/**
 * "3 hours ago", "yesterday", "in 2 days"; a week or more away it is the date. Against an injected `now`, so it is the
 * same on every machine (the component reads the clock; this function never does).
 */
export function formatRelative(value: Date, nowMs: number): string {
  const minutes = Math.round((value.getTime() - nowMs) / MINUTE);
  const distance = Math.abs(minutes);
  if (distance < 1) return 'just now';
  if (distance < 60) return relative.format(minutes, 'minute');
  if (distance < 1440) return relative.format(Math.round(minutes / 60), 'hour');
  if (distance < 7 * 1440) return relative.format(Math.round(minutes / 1440), 'day');
  return formatDateUtc(value);
}

// One shared clock for every date on the page: it ticks once a minute while at least one is mounted.
const listeners = new Set<() => void>();
let tick = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    timer = setInterval(() => {
      tick = Date.now();
      for (const notify of listeners) notify();
    }, MINUTE);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

function snapshot(): number {
  if (tick === 0) tick = Date.now();
  return tick;
}

export interface RelativeTimeProps {
  value: DateInput;
  className?: string;
}

/**
 * A moment as "3 hours ago", with the exact UTC time in a tooltip and in the text a screen reader hears. The server and
 * the first paint show the exact date, so the page never differs between the two; the relative text follows on the client.
 */
export function RelativeTime({ value, className }: RelativeTimeProps) {
  const now = useSyncExternalStore(subscribe, snapshot, () => null);
  const date = value === null || value === undefined ? null : new Date(value);
  if (!date || Number.isNaN(date.getTime()))
    return <span className={className}>{NOT_AVAILABLE}</span>;
  const exact = formatDateTimeUtc(date);
  return (
    <time dateTime={date.toISOString()} title={exact} className={className}>
      {now === null ? exact : formatRelative(date, now)}
      {now === null ? null : <span className="cg-sr-only"> ({exact})</span>}
    </time>
  );
}
