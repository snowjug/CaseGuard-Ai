'use client';

import {
  KeyValueList,
  LoadingSkeleton,
  Notice,
  Panel,
  TimeCursor,
  UiLink,
  cg,
  formatDateTimeUtc,
  formatNumber,
  type TimeCursorMarker,
} from '@caseguard/ui';
import { Button, makeStyles, tokens } from '@fluentui/react-components';
import { useMemo } from 'react';
import { caseHref } from '../../lib/deep-links';
import { LaterDecisionsNote } from './as-of';
import type { CaseTimeRange } from './case-hooks';

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: cg.space[3], minWidth: 0 },
  note: { margin: 0, fontSize: tokens.fontSizeBase300, color: cg.textSecondary },
  links: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: `${cg.space[1]} ${cg.space[3]}`,
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: '24px',
    color: cg.textLink,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    textDecorationLine: 'none',
    ':hover': { textDecorationLine: 'underline' },
  },
});

/** What the engine knew at the boundary, as the API counted it (never the content of later events). */
export interface KnownSummary {
  evidenceCount: number;
  claimCount: number;
  criticalMissingCount: number;
  openWarningCount: number;
  withheldFutureEventCount: number;
  /**
   * The instant the evidence was cut, as the API reports it: the last event recorded by the boundary, which can be earlier
   * than the instant that was asked for. `null` when no event had been recorded yet. Always shown instead of the request.
   */
  cutAt: string | null;
}

/** Idle time before the cursor's position is sent: a drag is one request, made when the person lets go. */
export const CURSOR_COMMIT_MS = 250;

export interface AsOfPanelProps {
  caseId: string;
  range: CaseTimeRange | null;
  /** The temporal boundary in force (`?asOf`, already moved to an event instant), or null for the whole record. */
  asOf: string | null;
  onChange: (asOf: string | null) => void;
  /** Every event instant of the case: tick marks, and the targets of "previous event" and "next event". Instants only. */
  instants?: readonly string[] | null | undefined;
  /** Set when the event instants could not be read: the cursor then cannot land on an event. */
  instantsFailed?: boolean | undefined;
  /** Reads the event instants again (offered when `instantsFailed`). */
  onRetryInstants?: (() => void) | undefined;
  /** Counts and cut instant at the boundary, from the API; omitted while loading or when no boundary is set. */
  known?: KnownSummary | null;
  /**
   * Set while the counts of the boundary are being fetched: the panel says which moment it is looking up and shows a
   * placeholder, and nothing of any other moment. Leave it unset once the fetch has ended, or an error that is not a rate
   * limit would look like an endless wait.
   */
  loading?: boolean;
  /** Set when the counts could not be computed because earlier views are rate limited (the page explains and retries). */
  limited?: boolean;
  /**
   * Show "Reviewer decisions recorded later are not shown in this earlier view" under the counts (default). A page that
   * shows decisions itself puts the note next to them instead.
   */
  decisionsNote?: boolean;
  /** Pages to offer "the same moment in ..." links to (default: Timeline, Evidence Ledger, Hypothesis Arena). */
  linkTo?: readonly ('timeline' | 'evidence' | 'hypotheses')[];
  headingLevel?: 2 | 3;
}

const LINK_LABELS = {
  timeline: 'Case Timeline',
  evidence: 'Evidence Ledger',
  hypotheses: 'Hypothesis Arena',
} as const;

const HELP =
  'The time cursor shows the case as it stood at one moment. When it is set, only events and findings recorded at or before that moment are used and shown. Later events are only counted, never displayed, so you can review a decision with exactly the information the engineer had. The cursor lands on an event: nothing changes between two events, and each earlier view is computed once and then kept. The moment is part of the address, so you can share it.';

/** The marks the cursor steps between: one per event instant, without any content. */
const markersOf = (instants: readonly string[] | null | undefined): TimeCursorMarker[] =>
  (instants ?? []).map((at) => ({ at, label: '' }));

/**
 * The "what was known" panel shared by the case pages: the time cursor, the plain-language statement of the boundary
 * and the counts the API computed at that instant. It changes `?asOf` only; the API enforces the boundary and this
 * component never asks for, keeps or derives anything from later events. The boundary it states is the instant the API
 * says the evidence was cut at, never the one that was asked for. While the counts of a moment are loading it says which
 * moment it is looking up; it never shows the counts of another one.
 */
export function AsOfPanel({
  caseId,
  range,
  asOf,
  onChange,
  instants,
  instantsFailed = false,
  onRetryInstants,
  known,
  loading = false,
  limited = false,
  decisionsNote = true,
  linkTo = ['timeline', 'evidence', 'hypotheses'],
  headingLevel = 2,
}: AsOfPanelProps) {
  const styles = useStyles();
  const query = asOf ? `?asOf=${encodeURIComponent(asOf)}` : '';
  const markers = useMemo(() => markersOf(instants), [instants]);
  const cutText = known ? (known.cutAt ? formatDateTimeUtc(known.cutAt) : null) : undefined;
  const lookingUp = asOf ? `Looking up what was known at ${formatDateTimeUtc(asOf)}…` : '';
  const description =
    asOf === null
      ? 'Move the cursor to see the case as it stood at an earlier moment.'
      : cutText === null
        ? 'No event had been recorded by the moment you chose.'
        : cutText !== undefined
          ? `Showing the case as of ${cutText}, the last event recorded by the moment you chose.`
          : limited
            ? 'What was known at the moment you chose could not be worked out just now.'
            : loading
              ? lookingUp
              : 'What was known at the moment you chose could not be loaded.';
  return (
    <Panel
      title="What was known"
      level={headingLevel}
      description={description}
      help={HELP}
      bodyClassName={styles.body}
    >
      {range ? (
        <TimeCursor
          min={range.min}
          max={range.max}
          value={asOf}
          onChange={onChange}
          markers={markers}
          commitDelayMs={CURSOR_COMMIT_MS}
          {...(known ? { withheldCount: known.withheldFutureEventCount } : {})}
          label="Time cursor"
        />
      ) : (
        <p className={styles.note}>
          This case has a single instant, so there is no earlier moment to look at.
        </p>
      )}
      {instantsFailed && onRetryInstants ? (
        <Notice variant="info" compact title={null}>
          The events of this case could not be listed, so the cursor cannot land on one.{' '}
          <Button appearance="transparent" size="small" onClick={onRetryInstants}>
            Try again
          </Button>
        </Notice>
      ) : null}
      {asOf ? (
        known ? (
          <KeyValueList
            aria-label={cutText ? `Known as of ${cutText}` : 'Known at the chosen moment'}
            layout="inline"
            items={[
              { id: 'evidence', label: 'Evidence items', value: formatNumber(known.evidenceCount) },
              { id: 'claims', label: 'Claims', value: formatNumber(known.claimCount) },
              {
                id: 'missing',
                label: 'Critical evidence still missing',
                value: formatNumber(known.criticalMissingCount),
              },
              {
                id: 'warnings',
                label: 'Open warnings',
                value: formatNumber(known.openWarningCount),
              },
              {
                id: 'withheld',
                label: 'Later events withheld',
                value: formatNumber(known.withheldFutureEventCount),
                hint: 'Counted only; their content is not shown.',
              },
            ]}
          />
        ) : limited ? (
          <p className={styles.note}>
            Counts for this moment are not available right now: earlier views are limited.
          </p>
        ) : loading ? (
          <LoadingSkeleton variant="text" count={4} label="Counting what was known" />
        ) : (
          <p className={styles.note}>The counts for this moment could not be loaded.</p>
        )
      ) : (
        <p className={styles.note}>Showing the whole record, up to the last event.</p>
      )}
      {asOf && decisionsNote ? <LaterDecisionsNote /> : null}
      <ul className={styles.links} aria-label="Open this moment in another view">
        {linkTo.map((section) => (
          <li key={section}>
            <UiLink href={`${caseHref(caseId, section)}${query}`} className={styles.link}>
              {asOf ? `${LINK_LABELS[section]} at this moment` : LINK_LABELS[section]}
            </UiLink>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
