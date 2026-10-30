'use client';

import { Button, Slider, makeStyles, tokens } from '@fluentui/react-components';
import { ArrowNextRegular, ArrowPreviousRegular, HistoryRegular } from '@fluentui/react-icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { VisuallyHidden } from '../a11y/VisuallyHidden';
import { formatDateTimeUtc } from '../format';
import { cg } from '../tokens/cg';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    padding: cg.space[3],
    borderRadius: cg.radius.lg,
    backgroundColor: cg.surface,
    border: `1px solid ${cg.borderSubtle}`,
    color: cg.text,
  },
  head: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: cg.space[2],
  },
  label: {
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.textMuted,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  known: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: 'tabular-nums',
  },
  withheld: { fontSize: tokens.fontSizeBase200, color: cg.textSecondary },
  controls: { display: 'flex', alignItems: 'center', gap: cg.space[2] },
  sliderWrap: { position: 'relative', flex: 1, minWidth: 0, paddingBottom: '6px' },
  slider: { width: '100%', minWidth: 0 },
  // Fluent draws a step notch (in the page colour) every `step`; with minute resolution that would paint over the rail.
  rail: { '::before': { display: 'none' } },
  ticks: {
    position: 'absolute',
    left: '10px',
    right: '10px',
    bottom: 0,
    height: '8px',
    pointerEvents: 'none',
  },
  tick: {
    position: 'absolute',
    bottom: 0,
    width: '2px',
    height: '8px',
    marginLeft: '-1px',
    borderRadius: '1px',
    backgroundColor: cg.tone.fork.solid,
  },
  ends: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: tokens.fontSizeBase200,
    color: cg.textMuted,
    fontVariantNumeric: 'tabular-nums',
  },
});

export interface TimeCursorMarker {
  /** Event instant (ISO UTC). */
  at: string;
  label?: string;
}

export interface TimeCursorProps {
  /** Earliest instant on the scrubber (ISO UTC). */
  min: string;
  /** Latest instant on the scrubber (ISO UTC). */
  max: string;
  /**
   * The temporal boundary (`asOf`). `null` means "no limit": everything up to `max` is known.
   * Dragging to the end of the range reports `null`.
   */
  value: string | null;
  onChange: (value: string | null) => void;
  /** Event instants; enables the previous/next event buttons. */
  markers?: readonly TimeCursorMarker[];
  /** Number of later events withheld by the boundary (a count, never content). */
  withheldCount?: number;
  /** Resolution of the slider in minutes (default 1). */
  stepMinutes?: number;
  /** Debounce before `onChange` fires while scrubbing, in ms (default 150). */
  commitDelayMs?: number;
  label?: string;
  disabled?: boolean;
}

const MINUTE = 60_000;

/**
 * Time-cursor scrubber. It announces "Known as of <UTC time>" to assistive technology, is fully keyboard
 * operable (arrows, Home/End, PageUp/PageDown on the slider; buttons for previous/next event and "Latest") and
 * never renders anything from the future: it only reports the boundary, the API enforces it.
 */
export function TimeCursor({
  min,
  max,
  value,
  onChange,
  markers = [],
  withheldCount,
  stepMinutes = 1,
  commitDelayMs = 150,
  label = 'Time cursor',
  disabled = false,
}: TimeCursorProps) {
  const styles = useStyles();
  const minMs = Date.parse(min);
  const maxMs = Date.parse(max);
  const valid = Number.isFinite(minMs) && Number.isFinite(maxMs) && maxMs > minMs;
  const stepMs = Math.max(1, stepMinutes) * MINUTE;
  const steps = valid ? Math.max(1, Math.ceil((maxMs - minMs) / stepMs)) : 1;

  const toIndex = (iso: string | null): number => {
    if (iso === null) return steps;
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return steps;
    return Math.min(steps, Math.max(0, Math.round((ms - minMs) / stepMs)));
  };
  const toIso = (index: number): string =>
    new Date(Math.min(maxMs, minMs + index * stepMs)).toISOString();

  const [draft, setDraft] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const committedIndex = toIndex(value);
  const index = draft ?? committedIndex;
  const shownIso = index >= steps ? null : toIso(index);
  const shownText = formatDateTimeUtc(shownIso ?? max);

  const commit = (nextIndex: number): void => {
    onChange(nextIndex >= steps ? null : toIso(nextIndex));
  };

  const sortedMarkers = useMemo(
    () =>
      [...markers]
        .map((m) => Date.parse(m.at))
        .filter((ms) => Number.isFinite(ms) && ms >= minMs && ms <= maxMs)
        .sort((a, b) => a - b),
    [markers, minMs, maxMs],
  );
  const currentMs = shownIso === null ? maxMs : Date.parse(shownIso);
  const previous = [...sortedMarkers].reverse().find((ms) => ms < currentMs);
  const next = sortedMarkers.find((ms) => ms > currentMs);

  const jumpTo = (ms: number | undefined): void => {
    if (ms === undefined) return;
    if (timer.current) clearTimeout(timer.current);
    setDraft(null);
    onChange(ms >= maxMs ? null : new Date(ms).toISOString());
  };

  if (!valid) {
    return (
      <div className={styles.root}>
        <p className={styles.label}>{label}</p>
        <span className={styles.withheld}>The case has no time range to scrub yet.</span>
      </div>
    );
  }

  return (
    <div className={styles.root} role="group" aria-label={label}>
      <div className={styles.head}>
        <p className={styles.label}>{label}</p>
        <span className={styles.known}>
          {shownIso === null ? `Latest: ${shownText}` : `Known as of ${shownText}`}
        </span>
      </div>
      <div className={styles.controls}>
        {markers.length > 0 ? (
          <Button
            size="small"
            appearance="subtle"
            icon={<ArrowPreviousRegular />}
            aria-label="Previous event"
            title="Previous event"
            disabled={disabled || previous === undefined}
            onClick={() => jumpTo(previous)}
          />
        ) : null}
        <div className={styles.sliderWrap}>
          <Slider
            className={styles.slider}
            rail={{ className: styles.rail }}
            min={0}
            max={steps}
            step={1}
            value={index}
            disabled={disabled}
            aria-label={label}
            aria-valuetext={shownIso === null ? `Latest, ${shownText}` : `Known as of ${shownText}`}
            onChange={(_event, data) => {
              setDraft(data.value);
              if (timer.current) clearTimeout(timer.current);
              timer.current = setTimeout(() => {
                commit(data.value);
                setDraft(null);
              }, commitDelayMs);
            }}
          />
          {sortedMarkers.length > 0 ? (
            <div className={styles.ticks} aria-hidden="true">
              {sortedMarkers.map((ms) => (
                <span
                  key={ms}
                  className={styles.tick}
                  style={{ left: `${((ms - minMs) / (maxMs - minMs)) * 100}%` }}
                />
              ))}
            </div>
          ) : null}
        </div>
        {markers.length > 0 ? (
          <Button
            size="small"
            appearance="subtle"
            icon={<ArrowNextRegular />}
            aria-label="Next event"
            title="Next event"
            disabled={disabled || next === undefined}
            onClick={() => jumpTo(next)}
          />
        ) : null}
        <Button
          size="small"
          appearance="outline"
          icon={<HistoryRegular />}
          disabled={disabled || value === null}
          onClick={() => {
            if (timer.current) clearTimeout(timer.current);
            setDraft(null);
            onChange(null);
          }}
        >
          Latest
        </Button>
      </div>
      <div className={styles.ends} aria-hidden="true">
        <span>{formatDateTimeUtc(min)}</span>
        <span>{formatDateTimeUtc(max)}</span>
      </div>
      {withheldCount !== undefined && shownIso !== null ? (
        <span className={styles.withheld}>
          {withheldCount === 0
            ? 'No later events are withheld.'
            : `${withheldCount} later ${withheldCount === 1 ? 'event is' : 'events are'} withheld from this view.`}
        </span>
      ) : null}
      <VisuallyHidden role="status" aria-live="polite">
        {value === null
          ? `Showing everything up to ${formatDateTimeUtc(max)}`
          : `Known as of ${formatDateTimeUtc(value)}`}
      </VisuallyHidden>
    </div>
  );
}
