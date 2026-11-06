'use client';

import {
  Badge,
  Button,
  Card,
  IconButton,
  KeyValueList,
  LoadingSkeleton,
  TimeCursor,
  Tooltip,
  UiLink,
  VisuallyHidden,
  cg,
  formatDateTimeUtc,
  formatNumber,
  type TimeCursorMarker,
} from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { ChevronDownIcon, HistoryIcon, InfoIcon } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import type { CaseTimeRange } from '../../components/case/case-hooks';
import { caseHref } from '../../lib/deep-links';

const useStyles = makeStyles({
  root: { overflow: 'hidden' },
  head: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: cg.space[2],
    paddingInlineEnd: cg.space[3],
  },
  toggle: {
    display: 'flex',
    flex: '1 1 280px',
    minWidth: 0,
    alignItems: 'center',
    gap: cg.space[3],
    minHeight: '56px',
    boxSizing: 'border-box',
    padding: `${cg.space[3]} ${cg.space[4]}`,
    border: 0,
    backgroundColor: 'transparent',
    color: cg.text,
    textAlign: 'start',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: tokens.fontSizeBase300,
    ':hover': { backgroundColor: `color-mix(in srgb, ${cg.text} 4%, transparent)` },
    ':focus-visible': { outline: `2px solid ${cg.focus}`, outlineOffset: '-2px' },
  },
  icon: { display: 'inline-flex', flexShrink: 0, color: cg.tone.brand.fg, fontSize: '1.25em' },
  titles: { display: 'flex', flexDirection: 'column', gap: cg.space[1], minWidth: 0, flex: 1 },
  titleLine: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  title: { fontWeight: tokens.fontWeightSemibold },
  summary: {
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
  },
  chevron: {
    flexShrink: 0,
    color: cg.textSecondary,
    transitionProperty: 'transform',
    transitionDuration: cg.motion.base,
    transitionTimingFunction: cg.motion.easing,
  },
  chevronOpen: { transform: 'rotate(180deg)' },
  extras: { display: 'flex', alignItems: 'center', gap: cg.space[1] },
  panel: {
    display: 'grid',
    gridTemplateRows: '0fr',
    transitionProperty: 'grid-template-rows',
    transitionDuration: cg.motion.base,
    transitionTimingFunction: cg.motion.easing,
  },
  panelOpen: { gridTemplateRows: '1fr' },
  inner: { minHeight: 0, overflow: 'hidden' },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    padding: cg.space[4],
    borderTop: `1px solid ${cg.borderSubtle}`,
  },
  note: { margin: 0, fontSize: tokens.fontSizeBase300, color: cg.textSecondary },
  caption: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: cg.space[2],
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    color: cg.textSecondary,
  },
  captionIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
    height: tokens.lineHeightBase200,
    color: cg.textMuted,
  },
  links: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: `${cg.space[1]} ${cg.space[4]}`,
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
    '@media (pointer: coarse)': { minHeight: '44px' },
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

const REPLAY_TIP =
  'Replays the case as it stood at an earlier moment. Only events recorded by then are used and shown; later ones are counted, never displayed.';

const LINK_LABELS = {
  timeline: 'Timeline',
  evidence: 'Evidence',
  hypotheses: 'Possible causes',
} as const;

export type AsOfLink = keyof typeof LINK_LABELS;

/** The sentence every earlier view carries where reviewer decisions normally appear. */
export const LATER_DECISIONS_TEXT =
  'Reviewer decisions recorded later are not shown in this earlier view.';

/** A caption (not a banner) saying that decisions recorded after the chosen moment are withheld. */
export function LaterDecisionsCaption() {
  const styles = useStyles();
  return (
    <p className={styles.caption}>
      <span aria-hidden="true" className={styles.captionIcon}>
        <InfoIcon size={16} />
      </span>
      <span>{LATER_DECISIONS_TEXT}</span>
    </p>
  );
}

/** The marks the cursor steps between: one per event instant, without any content. */
const markersOf = (instants: readonly string[] | null | undefined): TimeCursorMarker[] =>
  (instants ?? []).map((at) => ({ at, label: '' }));

export interface WhatWasKnownBarProps {
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
  /** Set while the counts of the boundary are being fetched: says which moment is looked up, shows a placeholder. */
  loading?: boolean;
  /** Set when the counts could not be computed because earlier views are rate limited (the page explains and retries). */
  limited?: boolean;
  /** Show "Reviewer decisions recorded later are not shown" under the counts (default). */
  decisionsNote?: boolean;
  /** Pages to offer "the same moment in ..." links to. */
  linkTo?: readonly AsOfLink[];
}

/**
 * "What was known then": the time cursor of a case page as one quiet bar. Closed, it says which moment the page shows
 * and offers the way back to the latest; open, it holds the cursor, the counts the API computed at that instant and the
 * same moment in the other views. It changes `?asOf` only: the API enforces the boundary, and this component never asks
 * for, keeps or derives anything from later events. The boundary it states is the instant the API says the evidence was
 * cut at, never the one that was asked for; while the counts of a moment load it says which moment it is looking up.
 */
export function WhatWasKnownBar({
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
}: WhatWasKnownBarProps) {
  const styles = useStyles();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  // Adjusting state while rendering (not in an effect) is React's pattern for "remember that it was opened once".
  if (open && !everOpened) setEverOpened(true);
  const markers = useMemo(() => markersOf(instants), [instants]);
  const query = asOf ? `?asOf=${encodeURIComponent(asOf)}` : '';
  const cutText = known ? (known.cutAt ? formatDateTimeUtc(known.cutAt) : null) : undefined;
  const summary =
    asOf === null
      ? 'Showing the whole record, up to the last event.'
      : cutText === null
        ? 'No event had been recorded by the moment you chose.'
        : cutText !== undefined
          ? `Showing the case as of ${cutText}, the last event recorded by the moment you chose.`
          : limited
            ? 'What was known at the moment you chose could not be worked out just now.'
            : loading
              ? `Looking up what was known at ${formatDateTimeUtc(asOf)}…`
              : 'What was known at the moment you chose could not be loaded.';
  // The bar is usually closed when the moment changes (from a row, a link, Back): a screen reader is told once it is settled.
  const announcement =
    asOf === null
      ? 'Now showing the whole record.'
      : cutText
        ? `Now showing the case as of ${cutText}.`
        : '';

  return (
    <Card padding="none" flat className={styles.root}>
      <VisuallyHidden role="status">{announcement}</VisuallyHidden>
      <div className={styles.head}>
        <button
          type="button"
          id={`${id}-toggle`}
          className={styles.toggle}
          aria-expanded={open}
          aria-controls={`${id}-panel`}
          onClick={() => setOpen((value) => !value)}
        >
          <span aria-hidden="true" className={styles.icon}>
            <HistoryIcon />
          </span>
          <span className={styles.titles}>
            <span className={styles.titleLine}>
              <span className={styles.title}>What was known then</span>
              {asOf ? (
                <Badge tone="brand" size="sm">
                  Earlier view
                </Badge>
              ) : null}
            </span>
            <span className={styles.summary}>{summary}</span>
          </span>
          <ChevronDownIcon
            aria-hidden="true"
            className={mergeClasses(styles.chevron, open && styles.chevronOpen)}
          />
        </button>
        <div className={styles.extras}>
          {asOf ? (
            <Button variant="ghost" size="sm" icon={<HistoryIcon />} onClick={() => onChange(null)}>
              Back to latest
            </Button>
          ) : null}
          <Tooltip content={REPLAY_TIP}>
            <IconButton
              icon={<InfoIcon />}
              label="About what was known then"
              size="sm"
              tooltip={false}
            />
          </Tooltip>
        </div>
      </div>
      <div
        id={`${id}-panel`}
        role="region"
        aria-labelledby={`${id}-toggle`}
        inert={!open}
        className={mergeClasses(styles.panel, open && styles.panelOpen)}
      >
        <div className={styles.inner}>
          {open || everOpened ? (
            <div className={styles.body}>
              <p className={styles.note}>
                Move the cursor to replay the case as it stood at an earlier moment. Events recorded
                later are counted, never shown.
              </p>
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
                <p className={styles.note}>
                  The events of this case could not be listed, so the cursor cannot land on one.{' '}
                  <Button variant="ghost" size="sm" onClick={onRetryInstants}>
                    Try again
                  </Button>
                </p>
              ) : null}
              {asOf ? (
                known ? (
                  <KeyValueList
                    aria-label={cutText ? `Known as of ${cutText}` : 'Known at the chosen moment'}
                    layout="inline"
                    items={[
                      {
                        id: 'evidence',
                        label: 'Evidence items',
                        value: formatNumber(known.evidenceCount),
                      },
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
              ) : null}
              {asOf && decisionsNote ? <LaterDecisionsCaption /> : null}
              <ul className={styles.links} aria-label="Open this moment in another view">
                {linkTo.map((section) => (
                  <li key={section}>
                    <UiLink href={`${caseHref(caseId, section)}${query}`} className={styles.link}>
                      {asOf ? `${LINK_LABELS[section]} at this moment` : LINK_LABELS[section]}
                    </UiLink>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
