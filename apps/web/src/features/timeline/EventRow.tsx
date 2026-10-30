'use client';

import {
  EVENT_TYPE_LABELS,
  PARTICIPANT_ROLE_LABELS,
  type SimulatedTimelineEvent,
  type TimelineEvent,
} from '@caseguard/schemas';
import {
  BadgeShell,
  ProvenanceBadge,
  StatusBadge,
  UiLink,
  cg,
  formatDateTimeUtc,
  formatDuration,
  formatNumber,
  formatProbability,
} from '@caseguard/ui';
import { Button, Link, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  ArrowDownRegular,
  ArrowUpRegular,
  BranchForkRegular,
  BeakerRegular,
  HistoryRegular,
  SearchRegular,
} from '@fluentui/react-icons';
import { useId } from 'react';
import { CategoryBadge } from '../../components/case/CategoryBadge';
import { ExpandableText } from '../../components/case/ExpandableText';
import { EFFORT_LABELS } from '../../components/case/labels';
import { evidenceLinkHref } from '../../lib/deep-links';
import { EVENT_TYPE_ICONS } from './event-meta';

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    padding: cg.space[3],
    borderRadius: cg.radius.lg,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surface,
    minWidth: 0,
    marginBottom: cg.space[3],
  },
  selected: {
    boxShadow: `inset 4px 0 0 ${cg.tone.brand.solid}`,
    backgroundColor: cg.tone.brand.tint,
  },
  delay: { boxShadow: `inset 4px 0 0 ${cg.tone.uncertain.solid}` },
  simulated: {
    border: `1px dashed ${cg.tone.simulated.border}`,
    backgroundColor: cg.tone.simulated.tint,
  },
  head: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${cg.space[1]} ${cg.space[3]}`,
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase200,
  },
  time: {
    color: cg.text,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: 'tabular-nums',
  },
  type: { display: 'inline-flex', alignItems: 'center', gap: cg.space[1] },
  title: {
    margin: 0,
    color: cg.text,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
    overflowWrap: 'anywhere',
  },
  badges: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[1] },
  effects: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: `${cg.space[1]} ${cg.space[3]}`,
    margin: 0,
    padding: 0,
    listStyle: 'none',
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase200,
  },
  effect: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '2px',
    fontVariantNumeric: 'tabular-nums',
  },
  actions: { display: 'flex', flexWrap: 'wrap', gap: cg.space[1] },
  note: { margin: 0, color: cg.textSecondary, fontSize: tokens.fontSizeBase200 },
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: '24px',
    color: cg.textLink,
    textDecorationLine: 'none',
    ':hover': { textDecorationLine: 'underline' },
  },
});

export interface EventRowProps {
  caseId: string;
  event: TimelineEvent;
  selected: boolean;
  asOf: string | null;
  /** Why the wait before this event counts as a delay (from the API's delay list). */
  delayReason: string | undefined;
  /** The earlier event this diagnostic repeats, when the API found one. */
  repeatOf: string | undefined;
  hypothesisName: (id: string) => string;
  onSelect: (eventId: string) => void;
  onKnownAsOf: (event: TimelineEvent) => void;
  onZoom: (event: TimelineEvent) => void;
}

/** One recorded event: when, what kind, who, the text (clamped), the diagnostics the engine found and what it changed. */
export function EventRow({
  caseId,
  event,
  selected,
  asOf,
  delayReason,
  repeatOf,
  hypothesisName,
  onSelect,
  onKnownAsOf,
  onZoom,
}: EventRowProps) {
  const styles = useStyles();
  const headingId = useId();
  const Icon = EVENT_TYPE_ICONS[event.type];
  const title = event.title ?? event.actionLabel ?? EVENT_TYPE_LABELS[event.type];
  const query = asOf ? `&asOf=${encodeURIComponent(asOf)}` : '';
  return (
    <article
      aria-labelledby={headingId}
      aria-current={selected ? 'true' : undefined}
      className={mergeClasses(
        styles.card,
        selected && styles.selected,
        event.isDelay && !selected && styles.delay,
      )}
    >
      <div className={styles.head}>
        <time className={styles.time} dateTime={event.timestamp}>
          {formatDateTimeUtc(event.timestamp)}
        </time>
        <span className={styles.type}>
          <Icon aria-hidden="true" />
          {EVENT_TYPE_LABELS[event.type]}
        </span>
        <span>
          {event.participantAlias} · {PARTICIPANT_ROLE_LABELS[event.participantRole]}
        </span>
        <span>Event {event.id}</span>
      </div>
      <h3 id={headingId} className={styles.title}>
        {title}
      </h3>
      <div className={styles.badges}>
        {event.isDelay ? (
          <StatusBadge
            status="uncertain"
            size="small"
            label={`Delay: ${formatDuration(event.gapMinutes)}`}
          />
        ) : event.gapMinutes !== null && event.gapMinutes > 0 ? (
          <span className={styles.note}>
            {formatDuration(event.gapMinutes)} after the previous event
          </span>
        ) : null}
        {event.isRepeatedDiagnostic ? (
          <StatusBadge status="unsupported" size="small" label="Repeated diagnostic" />
        ) : null}
        {event.destructive ? (
          <StatusBadge status="unsupported" size="small" label="Destructive action" />
        ) : null}
        {event.forkIds.length > 0 ? (
          <BadgeShell
            tone="fork"
            pattern="solid"
            icon={<BranchForkRegular />}
            label={
              event.forkIds.length > 1 ? `${event.forkIds.length} decision forks` : 'Decision fork'
            }
            size="small"
          />
        ) : null}
        {event.customerEffort && event.customerEffort !== 'none' ? (
          <span className={styles.note}>{EFFORT_LABELS[event.customerEffort]}</span>
        ) : null}
      </div>
      {event.isDelay && delayReason ? <p className={styles.note}>{delayReason}</p> : null}
      {event.isRepeatedDiagnostic && repeatOf ? (
        <p className={styles.note}>
          Repeats the same diagnostic as event{' '}
          <Link as="button" onClick={() => onSelect(repeatOf)}>
            {repeatOf}
          </Link>
          .
        </p>
      ) : null}
      {event.actionLabel && event.actionLabel !== title ? (
        <p className={styles.note}>Action: {event.actionLabel}</p>
      ) : null}
      <ExpandableText text={event.bodyExcerpt} lines={3} label="event text" />
      {event.bodyTruncated ? (
        <p className={styles.note}>This is an excerpt. Open the details for the full text.</p>
      ) : null}
      {event.categories.length > 0 ? (
        <div className={styles.badges} role="group" aria-label="Evidence categories of its claims">
          {event.categories.map((category) => (
            <CategoryBadge key={category} category={category} />
          ))}
        </div>
      ) : null}
      {event.hypothesisEffects.length > 0 ? (
        <ul
          className={styles.effects}
          aria-label="Effect on hypothesis confidence (model estimate)"
        >
          {event.hypothesisEffects.map((effect) => {
            const up = effect.delta > 0;
            const Arrow = up ? ArrowUpRegular : ArrowDownRegular;
            return (
              <li key={effect.hypothesisId} className={styles.effect}>
                <Arrow aria-hidden="true" />
                <span>
                  {hypothesisName(effect.hypothesisId)} {up ? 'up' : 'down'}{' '}
                  {formatNumber(Math.abs(effect.delta) * 100, { maximumFractionDigits: 1 })} points
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {event.forkIds.length > 0 ? (
        <p className={styles.note}>
          {event.forkIds.map((forkId, position) => (
            <span key={forkId}>
              {position > 0 ? ', ' : ''}
              <UiLink
                href={`${evidenceLinkHref(caseId, { type: 'fork', id: forkId })}${query}`}
                className={styles.link}
              >
                Inspect fork {position + 1} in the Counterfactual Lab
              </UiLink>
            </span>
          ))}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button
          size="small"
          appearance={selected ? 'primary' : 'outline'}
          icon={<SearchRegular />}
          aria-pressed={selected}
          aria-label={`Details of ${title}, ${formatDateTimeUtc(event.timestamp)}`}
          onClick={() => onSelect(event.id)}
        >
          Details
        </Button>
        <Button
          size="small"
          appearance="subtle"
          icon={<HistoryRegular />}
          aria-label={`Known as of here: show what was known as of ${formatDateTimeUtc(event.timestamp)}`}
          onClick={() => onKnownAsOf(event)}
        >
          Known as of here
        </Button>
        <Button
          size="small"
          appearance="subtle"
          aria-label={`Zoom here: only the events around ${title}`}
          onClick={() => onZoom(event)}
        >
          Zoom here
        </Button>
      </div>
    </article>
  );
}

export interface SimulatedRowProps {
  step: SimulatedTimelineEvent;
}

/** A simulated step of the overlaid counterfactual: dashed, hatched and always labelled Simulated and Estimated. */
export function SimulatedRow({ step }: SimulatedRowProps) {
  const styles = useStyles();
  const headingId = useId();
  return (
    <article aria-labelledby={headingId} className={mergeClasses(styles.card, styles.simulated)}>
      <div className={styles.head}>
        <time className={styles.time} dateTime={step.timestamp}>
          {formatDateTimeUtc(step.timestamp)}
        </time>
        <ProvenanceBadge kind="simulated" />
        <ProvenanceBadge kind="estimated" />
        <span className={styles.type}>
          <BeakerRegular aria-hidden="true" />
          Step {step.stepIndex + 1} of the simulated path
        </span>
      </div>
      <h3 id={headingId} className={styles.title}>
        {step.label}
      </h3>
      <p className={styles.note}>
        Predicted outcome: {step.outcomeLabel} (estimated probability{' '}
        {formatProbability(step.probability)}).
        {step.customerEffort !== 'none' ? ` ${EFFORT_LABELS[step.customerEffort]}.` : ''}
      </p>
    </article>
  );
}
