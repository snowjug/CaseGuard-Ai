'use client';

import type { TimelineResponse } from '@caseguard/schemas';
import {
  Badge,
  Card,
  HelpButton,
  KeyValueList,
  TimeCursor,
  cg,
  formatNumber,
  type TimeCursorMarker,
} from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { ChevronDownIcon, HistoryIcon } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { CURSOR_COMMIT_MS } from '../../components/case/AsOfPanel';
import { isRateLimited } from '../../components/case/as-of';
import { formatBoundary, type CaseTimeRange } from './case-hooks';
import { FailureNotice } from './FailureNotice';
import { explainFailure } from './failure';
import { useLook } from './look';

const HELP =
  'The time cursor shows the case as it stood at one moment. With it set, the score, metrics, warnings and skill matches are recomputed from only the events and findings on record at or before that moment; later events are counted, never shown. The cursor lands on an event: nothing changes between two events, and each earlier view is computed once and then kept. Coaching and the comparison look back at the finished case, so they ignore the cursor and say so. The moment is part of the address, so you can share it.';

const useStyles = makeStyles({
  barActive: {
    border: `1px solid color-mix(in srgb, ${cg.tone.brand.border} 55%, transparent)`,
    backgroundColor: `color-mix(in srgb, ${cg.tone.brand.tint} 70%, ${cg.glass})`,
  },
  head: { display: 'flex', alignItems: 'center', gap: cg.space[1], paddingInlineEnd: cg.space[2] },
  toggle: {
    display: 'flex',
    flex: '1 1 auto',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: `${cg.space[1]} ${cg.space[3]}`,
    minWidth: 0,
    minHeight: '48px',
    paddingBlock: cg.space[2],
    paddingInline: cg.space[4],
    border: 0,
    borderRadius: cg.radius.lg,
    backgroundColor: 'transparent',
    color: cg.text,
    fontFamily: 'inherit',
    fontSize: tokens.fontSizeBase300,
    textAlign: 'start',
    cursor: 'pointer',
    ':focus-visible': { outline: `2px solid ${cg.focus}`, outlineOffset: '-2px' },
  },
  icon: { display: 'inline-flex', flexShrink: 0, color: cg.tone.brand.fg, fontSize: '1.25em' },
  title: { fontWeight: tokens.fontWeightSemibold },
  summary: {
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase200,
    fontVariantNumeric: 'tabular-nums',
  },
  spacer: { flex: '1 1 0', minWidth: 0 },
  chevron: {
    flexShrink: 0,
    color: cg.textSecondary,
    transitionProperty: 'transform',
    transitionDuration: cg.motion.base,
    transitionTimingFunction: cg.motion.easing,
  },
  chevronOpen: { transform: 'rotate(180deg)' },
  // Opens by animating its grid row from 0fr to 1fr, as the kit's accordion does.
  region: {
    display: 'grid',
    gridTemplateRows: '0fr',
    transitionProperty: 'grid-template-rows',
    transitionDuration: cg.motion.base,
    transitionTimingFunction: cg.motion.easing,
  },
  regionOpen: { gridTemplateRows: '1fr' },
  inner: { minHeight: 0, overflow: 'hidden' },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    paddingInline: cg.space[4],
    paddingBottom: cg.space[4],
    // The cursor draws its own surface; inside this bar it sits straight on the card.
    '& > [role="group"]': { border: 0, backgroundColor: 'transparent', padding: 0 },
  },
});

export interface AsOfBarProps {
  range: CaseTimeRange | null;
  /** The temporal boundary in force (`?asOf`, already moved to an event instant), or null for the whole record. */
  asOf: string | null;
  onChange: (asOf: string | null) => void;
  /**
   * Every event instant of the case (ascending), or null while they are unknown: the cursor's tick marks and the
   * targets of "previous event" and "next event". Instants only; nothing of an event is shown or kept.
   */
  instants: readonly string[] | null;
  /** The counts at the boundary, from a one-row timeline read of the same moment; none while it loads or when it failed. */
  known: TimelineResponse | undefined;
  knownError: unknown;
  /** The counts at the boundary are being looked up. */
  loading: boolean;
}

/** The marks the cursor steps between: one per event instant, without any content. */
const markersOf = (instants: readonly string[] | null): TimeCursorMarker[] =>
  (instants ?? []).map((at) => ({ at, label: '' }));

/**
 * "What was known then": a slim bar at the top of the page that opens to the time cursor, the plain-language statement of
 * the boundary and the counts the API computed at that instant. It starts closed, unless the address already carries a
 * moment, and says in one line which view the page shows. It changes `?asOf` only; the API enforces the boundary and
 * nothing on the page asks for, keeps or derives anything from later events. The cursor lands on an event and is sent once
 * the person stops moving it. The instant it states is the one the API says the evidence was cut at, never just the one
 * that was asked for.
 */
export function AsOfBar({
  range,
  asOf,
  onChange,
  instants,
  known,
  knownError,
  loading,
}: AsOfBarProps) {
  const styles = useStyles();
  const look = useLook();
  const regionId = useId();
  const markers = useMemo(() => markersOf(instants), [instants]);
  // Starts open when the address already names a moment; after that the person decides.
  const [open, setOpen] = useState(asOf !== null);
  const [everOpened, setEverOpened] = useState(open);
  if (open && !everOpened) setEverOpened(true);
  const counts = asOf ? known?.knownAtAsOf : undefined;
  const withheld = asOf ? known?.withheldFutureEventCount : undefined;
  const limited = asOf !== null && isRateLimited(knownError);
  const failed = asOf !== null && Boolean(knownError);
  const description =
    asOf === null
      ? 'Move the cursor to review the case as it stood at an earlier moment.'
      : known === undefined
        ? failed
          ? 'What was known at the moment you chose could not be worked out just now.'
          : 'Looking up what was known at the moment you chose…'
        : known.asOf === null
          ? 'No event had been recorded by the moment you chose.'
          : `The case as it stood on ${formatBoundary(known.asOf)}, the last event recorded by the moment you chose.`;
  return (
    <Card
      role="group"
      aria-label="What was known then"
      padding="none"
      className={asOf !== null ? styles.barActive : undefined}
    >
      <div className={styles.head}>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={open}
          aria-controls={regionId}
          onClick={() => setOpen((value) => !value)}
        >
          <span aria-hidden="true" className={styles.icon}>
            <HistoryIcon />
          </span>
          <span className={styles.title}>What was known then</span>
          {asOf === null ? (
            <span className={styles.summary}>Showing the whole record</span>
          ) : (
            <>
              <Badge tone="brand" size="sm">
                Earlier view
              </Badge>
              <span className={styles.summary}>As of {formatBoundary(asOf)}</span>
            </>
          )}
          <span className={styles.spacer} />
          <ChevronDownIcon
            aria-hidden="true"
            className={mergeClasses(styles.chevron, open && styles.chevronOpen)}
          />
        </button>
        <HelpButton label="About what was known then" title="What was known then">
          {HELP}
        </HelpButton>
      </div>
      <div
        id={regionId}
        inert={!open}
        className={mergeClasses(styles.region, open && styles.regionOpen)}
      >
        <div className={styles.inner}>
          {everOpened ? (
            <div className={styles.body}>
              <p className={look.text}>{description}</p>
              {range ? (
                <TimeCursor
                  min={range.min}
                  max={range.max}
                  value={asOf}
                  onChange={onChange}
                  markers={markers}
                  {...(withheld !== undefined ? { withheldCount: withheld } : {})}
                  commitDelayMs={CURSOR_COMMIT_MS}
                  label="Time cursor"
                />
              ) : (
                <p className={look.text}>
                  This case spans a single instant, so there is no earlier moment to look at.
                </p>
              )}
              {asOf ? (
                <p className={look.meta}>
                  Known as of {formatBoundary(asOf)}. The score, metrics, warnings and skill matches
                  use only what was on record by then; later events are counted, never shown.
                  Coaching and the case comparison look back at the finished case and do not follow
                  the cursor.
                </p>
              ) : (
                <p className={look.meta}>Showing the whole record, up to the last event.</p>
              )}
              {asOf && counts ? (
                <KeyValueList
                  aria-label={`Known as of ${formatBoundary(asOf)}`}
                  layout="inline"
                  items={[
                    {
                      id: 'evidence',
                      label: 'Evidence items',
                      value: formatNumber(counts.evidenceCount, { maximumFractionDigits: 0 }),
                    },
                    {
                      id: 'claims',
                      label: 'Claims',
                      value: formatNumber(counts.claimCount, { maximumFractionDigits: 0 }),
                    },
                    {
                      id: 'missing',
                      label: 'Critical evidence still missing',
                      value: formatNumber(counts.criticalMissingCount, {
                        maximumFractionDigits: 0,
                      }),
                    },
                    {
                      id: 'warnings',
                      label: 'Open warnings',
                      value: formatNumber(counts.openWarningCount, { maximumFractionDigits: 0 }),
                    },
                  ]}
                />
              ) : asOf && limited ? (
                <p className={look.text}>
                  Counts for this moment are not available right now: earlier views are limited.
                </p>
              ) : asOf && knownError ? (
                <FailureNotice failure={explainFailure(knownError)} />
              ) : asOf && loading ? (
                <p className={look.text} role="status">
                  Counting what was known…
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
