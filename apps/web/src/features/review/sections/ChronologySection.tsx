'use client';

import {
  EmptyState,
  Notice,
  StatusBadge,
  UiLink,
  cg,
  formatDateTimeUtc,
  useMediaQuery,
} from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { HistoryRegular, HourglassRegular } from '@fluentui/react-icons';
import { useMemo } from 'react';
import { LinkButton } from '../../../components/common/LinkButton';
import { caseHref, evidenceLinkHref } from '../../../lib/deep-links';
import { useDetailHandle, useForksHandle, useRunHandle, useTimelineHandle } from '../hooks';
import {
  KEY_REASON_WORDS,
  LANES,
  chronologyRows,
  deriveChronology,
  type ChronologyEvent,
  type KeyReason,
} from '../model/chronology';
import { methodNotes } from '../model/method';
import { plural } from '../model/words';
import { ChronologyStrip } from './ChronologyStrip';
import { PartState, SectionFrame } from './shared';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  text: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  head: {
    display: 'none',
    '@media (min-width: 900px)': {
      display: 'grid',
      gridTemplateColumns: '150px repeat(3, minmax(0, 1fr))',
      gap: cg.space[2],
      fontSize: tokens.fontSizeBase200,
      fontWeight: tokens.fontWeightSemibold,
      color: cg.textSecondary,
      paddingBottom: cg.space[1],
      borderBottom: `1px solid ${cg.borderSubtle}`,
    },
  },
  row: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    gap: `${cg.space[1]} ${cg.space[2]}`,
    alignItems: 'start',
    '@media (min-width: 900px)': { gridTemplateColumns: '150px repeat(3, minmax(0, 1fr))' },
  },
  time: {
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    color: cg.textSecondary,
    fontVariantNumeric: 'tabular-nums',
  },
  lane0: { '@media (min-width: 900px)': { gridColumn: '2' } },
  lane1: { '@media (min-width: 900px)': { gridColumn: '3' } },
  lane2: { '@media (min-width: 900px)': { gridColumn: '4' } },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    minWidth: 0,
    padding: `${cg.space[2]} ${cg.space[3]}`,
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surfaceSunken,
  },
  decision: { borderLeft: `4px solid ${cg.tone.fork.solid}` },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
    overflowWrap: 'anywhere',
  },
  meta: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  badges: { display: 'flex', flexWrap: 'wrap', gap: cg.space[1] },
  link: {
    fontSize: tokens.fontSizeBase200,
    color: cg.textLink,
    textDecorationLine: 'underline',
    textUnderlineOffset: '2px',
    alignSelf: 'flex-start',
    minHeight: '24px',
  },
  wait: {
    display: 'flex',
    alignItems: 'center',
    gap: cg.space[2],
    padding: `${cg.space[1]} ${cg.space[3]}`,
    borderRadius: cg.radius.md,
    border: `1px dashed ${cg.tone.uncertain.border}`,
    backgroundColor: cg.tone.uncertain.tint,
    color: cg.tone.uncertain.fg,
    fontSize: tokens.fontSizeBase300,
    '@media (min-width: 900px)': { gridColumn: '2 / -1' },
  },
  actions: { display: 'flex', flexWrap: 'wrap', gap: cg.space[2] },
});

const REASON_BADGE: Record<KeyReason, 'neutral' | 'uncertain' | 'productive'> = {
  opened: 'neutral',
  decision: 'uncertain',
  escalation: 'neutral',
  validation: 'productive',
  resolution: 'productive',
  closed: 'neutral',
};

function EventCard({ caseId, event }: { caseId: string; event: ChronologyEvent }) {
  const styles = useStyles();
  const decision = event.reasons.includes('decision');
  return (
    <div className={mergeClasses(styles.card, decision && styles.decision)}>
      <p className={styles.title}>{event.title}</p>
      <p className={styles.meta}>
        {event.laneLabel} lane · {event.roleLabel} · {event.typeLabel}
      </p>
      <div className={styles.badges}>
        {event.reasons.map((reason) => (
          <StatusBadge
            key={reason}
            size="small"
            status={REASON_BADGE[reason]}
            label={
              reason === 'decision'
                ? event.decisionNumbers.map((n) => `Decision point ${n}`).join(', ')
                : KEY_REASON_WORDS[reason]
            }
          />
        ))}
      </div>
      <UiLink
        className={styles.link}
        href={evidenceLinkHref(caseId, { type: 'event', id: event.id })}
        aria-label={`Show in timeline: ${event.title}`}
      >
        Show in timeline
      </UiLink>
    </div>
  );
}

/**
 * The chronology: a picture of the case with a row per side, the decision points and the meaningful waits, and under it
 * the list that is its text alternative (the same key events and waits in words, in time order). Below 640 px the picture
 * gives way to the list alone, which is laid out as one column with the side named on each event.
 */
export function ChronologySection({ caseId }: { caseId: string }) {
  const styles = useStyles();
  const narrow = useMediaQuery('(max-width: 639px)', false);
  const timeline = useTimelineHandle(caseId);
  const forks = useForksHandle(caseId);
  const detail = useDetailHandle(caseId);
  const run = useRunHandle(caseId);
  const bundle = timeline.source.kind === 'ready' ? timeline.source.data : null;
  const forksData = forks.source.kind === 'ready' ? forks.source.data : null;
  const resolvedAt =
    detail.source.kind === 'ready' ? (detail.source.data.resolution?.resolvedAt ?? null) : null;
  const chronology = useMemo(
    () => (bundle ? deriveChronology(bundle.events, forksData, resolvedAt) : null),
    [bundle, forksData, resolvedAt],
  );
  const rows = useMemo(() => (chronology ? chronologyRows(chronology) : []), [chronology]);
  const notes = methodNotes('chronology', {
    run: run.source.kind === 'ready' ? run.source.data : null,
    quality: null,
    coaching: null,
    detail: null,
    path: null,
  });
  return (
    <SectionFrame
      id="chronology"
      title="Chronology"
      description="What happened, who was waiting for whom, and where the decisions were taken."
      method={notes}
    >
      {timeline.source.kind !== 'ready' ? (
        <PartState handle={timeline} what="the chronology" />
      ) : !chronology || chronology.total === 0 ? (
        <EmptyState
          compact
          icon={<HistoryRegular />}
          title="No events were recorded"
          description="There is nothing to draw for this case."
        />
      ) : (
        <div className={styles.stack}>
          {forks.source.kind === 'denied' || forks.source.kind === 'failed' ? (
            <Notice variant="info" compact title="Decision points not marked">
              The decision points could not be read, so they are not marked on the chronology.
            </Notice>
          ) : null}
          <p className={styles.text}>{chronology.summary}</p>
          {bundle?.truncated ? (
            <Notice variant="warning" compact title="Only part of the case is shown">
              The case has {plural(bundle.total, 'event')}; the chronology covers the first{' '}
              {plural(bundle.events.length, 'event')}.
            </Notice>
          ) : null}
          {narrow ? null : <ChronologyStrip chronology={chronology} />}
          <ol
            className={styles.list}
            aria-label={`Key events and waits, ${plural(chronology.events.length, 'key event')}`}
          >
            <li aria-hidden="true" className={mergeClasses(styles.row, styles.head)}>
              <span>Time (UTC)</span>
              {LANES.map((lane) => (
                <span key={lane.id}>{lane.label}</span>
              ))}
            </li>
            {rows.map((row) =>
              row.kind === 'event' ? (
                <li key={`event-${row.event.id}`} className={styles.row}>
                  <p className={styles.time}>{formatDateTimeUtc(row.event.at)}</p>
                  <div
                    className={
                      [styles.lane0, styles.lane1, styles.lane2][
                        LANES.findIndex((lane) => lane.id === row.event.lane)
                      ]
                    }
                  >
                    <EventCard caseId={caseId} event={row.event} />
                  </div>
                </li>
              ) : (
                <li
                  key={`wait-${row.wait.fromEventId}-${row.wait.toEventId}`}
                  className={styles.row}
                >
                  <p className={styles.time}>{formatDateTimeUtc(row.wait.fromAt)}</p>
                  <p className={styles.wait}>
                    <HourglassRegular aria-hidden="true" />
                    <span>
                      <strong>{row.wait.text}</strong> After “{row.wait.fromTitle}”, before “
                      {row.wait.toTitle}”.
                    </span>
                  </p>
                </li>
              ),
            )}
          </ol>
          <div className={styles.actions}>
            <LinkButton
              href={caseHref(caseId, 'timeline')}
              appearance="outline"
              icon={<HistoryRegular />}
            >
              Open the full timeline
            </LinkButton>
          </div>
        </div>
      )}
    </SectionFrame>
  );
}
