'use client';

import type { TimelineResponse } from '@caseguard/schemas';
import {
  KeyValueList,
  Notice,
  Panel,
  TimeCursor,
  formatNumber,
  type TimeCursorMarker,
} from '@caseguard/ui';
import { useMemo } from 'react';
import { CURSOR_COMMIT_MS } from '../../components/case/AsOfPanel';
import { isRateLimited } from '../../components/case/as-of';
import { formatBoundary, type CaseTimeRange } from './case-hooks';
import { FailureNotice } from './FailureNotice';
import { explainFailure } from './failure';
import { useInsightStyles } from './styles';

const HELP =
  'The time cursor shows the case as it stood at one moment. With it set, the quality index, metrics, warnings and SkillDNA matches are recomputed from only the events and findings on record at or before that moment; later events are counted, never shown. The cursor lands on an event: nothing changes between two events, and each earlier view is computed once and then kept. Coaching and the comparison review the finished case, so they ignore the cursor and say so. The moment is part of the address, so you can share it.';

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
 * The shared "what was known" panel: the time cursor, the plain-language statement of the boundary and the counts the
 * API computed at that instant. It changes `?asOf` only; the API enforces the boundary and nothing on the page asks for,
 * keeps or derives anything from later events. The cursor lands on an event and is sent once the person stops moving it.
 * The instant it states is the one the API says the evidence was cut at, never just the one that was asked for.
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
  const styles = useInsightStyles();
  const markers = useMemo(() => markersOf(instants), [instants]);
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
    <Panel title="What was known" description={description} help={HELP}>
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
        <p className={styles.text}>
          This case spans a single instant, so there is no earlier moment to look at.
        </p>
      )}
      {asOf ? (
        <Notice variant="info" compact title="Decision-time view">
          Known as of {formatBoundary(asOf)}. The quality index, metrics, warnings and SkillDNA
          matches use only what was on record by then; later events are counted, never shown.
          Coaching and the case comparison review the finished case and do not follow the cursor.
        </Notice>
      ) : (
        <p className={styles.text}>Showing the whole record, up to the last event.</p>
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
              value: formatNumber(counts.criticalMissingCount, { maximumFractionDigits: 0 }),
            },
            {
              id: 'warnings',
              label: 'Open warnings',
              value: formatNumber(counts.openWarningCount, { maximumFractionDigits: 0 }),
            },
          ]}
        />
      ) : asOf && limited ? (
        <p className={styles.text}>
          Counts for this moment are not available right now: earlier views are limited.
        </p>
      ) : asOf && knownError ? (
        <FailureNotice failure={explainFailure(knownError)} />
      ) : asOf && loading ? (
        <p className={styles.text} role="status">
          Counting what was known…
        </p>
      ) : null}
    </Panel>
  );
}
