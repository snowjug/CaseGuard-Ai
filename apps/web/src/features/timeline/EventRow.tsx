'use client';

import {
  EVENT_TYPE_LABELS,
  PARTICIPANT_ROLE_LABELS,
  type SimulatedTimelineEvent,
  type TimelineEvent,
} from '@caseguard/schemas';
import {
  Badge,
  Button,
  Card,
  IconButton,
  ProvenanceBadge,
  StatusBadge,
  UiLink,
  borderColors,
  cg,
  formatDateTimeUtc,
  formatDuration,
  formatNumber,
  formatProbability,
  useRestoreFocusTarget,
} from '@caseguard/ui';
import {
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  EllipsisIcon,
  FlaskConicalIcon,
  GitForkIcon,
  HistoryIcon,
  HourglassIcon,
  ZoomInIcon,
} from 'lucide-react';
import { useId } from 'react';
import { ExpandableText } from '../../components/case/ExpandableText';
import { EFFORT_LABELS } from '../../components/case/labels';
import { evidenceLinkHref } from '../../lib/deep-links';
import { EvidenceCategoryBadge } from '../evidence/category-meta';
import { EVENT_TYPE_ICONS } from './event-meta';

const RAIL_DOT = '28px';

const useStyles = makeStyles({
  entry: {
    display: 'grid',
    gridTemplateColumns: '24px minmax(0, 1fr)',
    columnGap: cg.space[3],
    paddingBottom: cg.space[3],
    '@media (max-width: 639px)': {
      gridTemplateColumns: '12px minmax(0, 1fr)',
      columnGap: cg.space[2],
    },
  },
  rail: {
    position: 'relative',
    '::before': {
      content: '""',
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: '50%',
      width: '2px',
      marginLeft: '-1px',
      backgroundColor: cg.borderSubtle,
    },
  },
  railFirst: { '::before': { top: RAIL_DOT } },
  railLast: { '::before': { bottom: 'auto', height: RAIL_DOT } },
  railOnly: { '::before': { display: 'none' } },
  dot: {
    position: 'absolute',
    top: '22px',
    left: '50%',
    width: '12px',
    height: '12px',
    transform: 'translateX(-50%)',
    boxSizing: 'border-box',
    borderRadius: cg.radius.pill,
    backgroundColor: cg.surface,
    border: `2px solid ${cg.borderControl}`,
    '@media (max-width: 639px)': { width: '10px', height: '10px' },
  },
  dotDelay: { backgroundColor: cg.tone.uncertain.solid, ...borderColors(cg.tone.uncertain.solid) },
  dotFork: { ...borderColors(cg.tone.brand.solid) },
  dotSelected: { backgroundColor: cg.tone.brand.solid, ...borderColors(cg.tone.brand.solid) },
  card: { gap: cg.space[2], overflow: 'hidden' },
  selected: {
    boxShadow: `inset 3px 0 0 ${cg.tone.brand.solid}`,
    backgroundColor: cg.tone.brand.tint,
  },
  simulated: {
    border: `1px dashed ${cg.tone.simulated.border}`,
    backgroundColor: cg.tone.simulated.tint,
  },
  delay: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${cg.space[1]} ${cg.space[3]}`,
    margin: `-${cg.space[4]} -${cg.space[4]} ${cg.space[1]}`,
    padding: `${cg.space[2]} ${cg.space[4]}`,
    backgroundColor: cg.tone.uncertain.tint,
    color: cg.text,
    fontSize: tokens.fontSizeBase200,
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
    letterSpacing: '-0.01em',
    overflowWrap: 'anywhere',
  },
  badges: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
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
    gap: cg.space[1],
    fontVariantNumeric: 'tabular-nums',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: cg.space[1],
  },
  note: { margin: 0, color: cg.textSecondary, fontSize: tokens.fontSizeBase200 },
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: '24px',
    color: cg.textLink,
    textDecorationLine: 'none',
    ':hover': { textDecorationLine: 'underline' },
    '@media (pointer: coarse)': { minHeight: '44px' },
  },
  linkButton: {
    display: 'inline',
    padding: 0,
    border: 0,
    backgroundColor: 'transparent',
    color: cg.textLink,
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    textDecorationLine: 'underline',
    ':focus-visible': { outline: `2px solid ${cg.focus}`, outlineOffset: '2px' },
  },
  popover: {
    padding: cg.space[1],
    borderRadius: cg.radius.md,
    backgroundColor: cg.surfaceRaised,
    border: `1px solid ${cg.glassBorder}`,
    boxShadow: cg.shadowHigh,
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
  /** First and last of the whole list: where the line of the timeline starts and ends. */
  first: boolean;
  last: boolean;
}

/** The dot on the line of the timeline: amber for a delay, the accent for a key decision or the open event. */
function Rail({
  first,
  last,
  delay,
  fork,
  selected,
}: {
  first: boolean;
  last: boolean;
  delay: boolean;
  fork: boolean;
  selected: boolean;
}) {
  const styles = useStyles();
  return (
    <div
      aria-hidden="true"
      className={mergeClasses(
        styles.rail,
        first && styles.railFirst,
        last && styles.railLast,
        first && last && styles.railOnly,
      )}
    >
      <span
        className={mergeClasses(
          styles.dot,
          delay && styles.dotDelay,
          fork && styles.dotFork,
          selected && styles.dotSelected,
        )}
      />
    </div>
  );
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
  first,
  last,
}: EventRowProps) {
  const styles = useStyles();
  const headingId = useId();
  const restoreFocus = useRestoreFocusTarget();
  const Icon = EVENT_TYPE_ICONS[event.type];
  const title = event.title ?? event.actionLabel ?? EVENT_TYPE_LABELS[event.type];
  const query = asOf ? `&asOf=${encodeURIComponent(asOf)}` : '';
  return (
    <div className={styles.entry}>
      <Rail
        first={first}
        last={last}
        delay={event.isDelay}
        fork={event.forkIds.length > 0}
        selected={selected}
      />
      <Card
        as="article"
        flat
        padding="sm"
        aria-labelledby={headingId}
        aria-current={selected ? 'true' : undefined}
        className={mergeClasses(styles.card, selected && styles.selected)}
      >
        {event.isDelay ? (
          <div className={styles.delay}>
            <Badge tone="uncertain" size="sm" icon={<HourglassIcon />}>
              {`Delay: ${formatDuration(event.gapMinutes)}`}
            </Badge>
            {delayReason ? <span>{delayReason}</span> : null}
          </div>
        ) : null}
        <div className={styles.head}>
          <time className={styles.time} dateTime={event.timestamp}>
            {formatDateTimeUtc(event.timestamp)}
          </time>
          <span className={styles.type}>
            <Icon aria-hidden="true" size={16} />
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
          {!event.isDelay && event.gapMinutes !== null && event.gapMinutes > 0 ? (
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
            <Badge tone="fork" size="sm" icon={<GitForkIcon />}>
              {event.forkIds.length > 1 ? `${event.forkIds.length} key decisions` : 'Key decision'}
            </Badge>
          ) : null}
          {event.customerEffort && event.customerEffort !== 'none' ? (
            <span className={styles.note}>{EFFORT_LABELS[event.customerEffort]}</span>
          ) : null}
        </div>
        {event.isRepeatedDiagnostic && repeatOf ? (
          <p className={styles.note}>
            Repeats the same diagnostic as event{' '}
            <button type="button" className={styles.linkButton} onClick={() => onSelect(repeatOf)}>
              {repeatOf}
            </button>
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
          <div
            className={styles.badges}
            role="group"
            aria-label="Evidence categories of its claims"
          >
            {event.categories.map((category) => (
              <EvidenceCategoryBadge key={category} category={category} />
            ))}
          </div>
        ) : null}
        {event.hypothesisEffects.length > 0 ? (
          <ul
            className={styles.effects}
            aria-label="Effect on the confidence in each possible cause (model estimate)"
          >
            {event.hypothesisEffects.map((effect) => {
              const up = effect.delta > 0;
              const Arrow = up ? ArrowUpIcon : ArrowDownIcon;
              return (
                <li key={effect.hypothesisId} className={styles.effect}>
                  <Arrow aria-hidden="true" size={16} />
                  <span>
                    {hypothesisName(effect.hypothesisId)} {up ? 'up' : 'down'}{' '}
                    {formatNumber(Math.abs(effect.delta) * 100, { maximumFractionDigits: 1 })}{' '}
                    points
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
                  See key decision {position + 1} in What if
                </UiLink>
              </span>
            ))}
          </p>
        ) : null}
        <div className={styles.actions}>
          <Button
            size="sm"
            variant="secondary"
            icon={<ChevronRightIcon />}
            iconPosition="end"
            aria-haspopup="dialog"
            aria-label={`Details of ${title}, ${formatDateTimeUtc(event.timestamp)}`}
            onClick={() => onSelect(event.id)}
            {...restoreFocus}
          >
            Details
          </Button>
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <IconButton
                icon={<EllipsisIcon />}
                label={`More actions for ${title}`}
                size="sm"
                tooltip={false}
              />
            </MenuTrigger>
            <MenuPopover className={styles.popover}>
              <MenuList>
                <MenuItem
                  icon={<HistoryIcon />}
                  aria-label={`What was known here: show the case as of ${formatDateTimeUtc(event.timestamp)}`}
                  onClick={() => onKnownAsOf(event)}
                >
                  What was known here
                </MenuItem>
                <MenuItem
                  icon={<ZoomInIcon />}
                  aria-label={`Zoom here: only the events around ${title}`}
                  onClick={() => onZoom(event)}
                >
                  Zoom here
                </MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
        </div>
      </Card>
    </div>
  );
}

export interface SimulatedRowProps {
  step: SimulatedTimelineEvent;
  first: boolean;
  last: boolean;
}

/** A simulated step of the overlaid what-if path: dashed and always labelled Simulated and Estimated. */
export function SimulatedRow({ step, first, last }: SimulatedRowProps) {
  const styles = useStyles();
  const headingId = useId();
  return (
    <div className={styles.entry}>
      <Rail first={first} last={last} delay={false} fork={false} selected={false} />
      <Card
        as="article"
        flat
        padding="sm"
        aria-labelledby={headingId}
        className={mergeClasses(styles.card, styles.simulated)}
      >
        <div className={styles.head}>
          <time className={styles.time} dateTime={step.timestamp}>
            {formatDateTimeUtc(step.timestamp)}
          </time>
          <ProvenanceBadge kind="simulated" />
          <ProvenanceBadge kind="estimated" />
          <span className={styles.type}>
            <FlaskConicalIcon aria-hidden="true" size={16} />
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
      </Card>
    </div>
  );
}
