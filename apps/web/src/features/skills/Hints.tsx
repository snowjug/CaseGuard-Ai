'use client';

import type { SkillLifecycle } from '@caseguard/schemas';
import { Badge, STATUS_META, Tooltip, cg, type BadgeStatus } from '@caseguard/ui';
import {
  Popover,
  PopoverSurface,
  PopoverTrigger,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { CalculatorIcon, FlaskConicalIcon, InfoIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  LIFECYCLE_BADGES,
  LIFECYCLE_LABELS,
  LIFECYCLE_MEANING,
  LIFECYCLE_STAGES_TEXT,
} from './labels';

const useStyles = makeStyles({
  // Sits above the stretched link of a card, so the tooltip answers to the pointer.
  tip: { position: 'relative', zIndex: 1, display: 'inline-flex', maxWidth: '100%' },
  tipBody: { display: 'flex', flexDirection: 'column', gap: cg.space[1] },
  pill: {
    display: 'inline-flex',
    alignItems: 'center',
    maxWidth: '100%',
    padding: 0,
    border: 0,
    backgroundColor: 'transparent',
    borderRadius: cg.radius.pill,
    cursor: 'pointer',
    fontFamily: 'inherit',
    minHeight: '28px',
    ':focus-visible': { outline: `2px solid ${cg.focus}`, outlineOffset: '2px' },
    '@media (pointer: coarse)': { minHeight: '44px' },
  },
  surface: {
    maxWidth: '320px',
    padding: cg.space[4],
    color: cg.text,
    backgroundColor: cg.surfaceRaised,
    border: `1px solid ${cg.glassBorder}`,
    borderRadius: cg.radius.md,
    boxShadow: cg.shadowHigh,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
  },
  popTitle: { margin: `0 0 ${cg.space[1]}`, fontWeight: tokens.fontWeightSemibold },
  popBody: { display: 'flex', flexDirection: 'column', gap: cg.space[2], color: cg.textSecondary },
});

/** A quality status as a small badge without a built-in tooltip: the wording of these badges is ours, not the status table's. */
export function StatusPill({
  status,
  label,
  size = 'sm',
}: {
  status: BadgeStatus;
  label: string;
  size?: 'sm' | 'md';
}) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <Badge
      tone={meta.tone}
      icon={<Icon />}
      size={size}
      {...(status === 'missing' ? { dashed: true, outlined: true } : {})}
    >
      {label}
    </Badge>
  );
}

export interface LifecycleBadgeProps {
  lifecycle: SkillLifecycle;
  size?: 'sm' | 'md';
}

/** The status of a skill as a badge: an icon, its word and a tone (never colour alone). */
export function LifecycleBadge({ lifecycle, size = 'md' }: LifecycleBadgeProps) {
  const look = LIFECYCLE_BADGES[lifecycle];
  const Icon = look.icon;
  return (
    <Badge
      tone={look.tone}
      icon={<Icon />}
      size={size}
      {...(look.dashed ? { dashed: true, outlined: true } : {})}
    >
      {look.label}
    </Badge>
  );
}

/** What a status says and where it sits among the others: the words of the tooltip and of the popover. */
export function StatusExplanation({
  lifecycle,
  showTitle = true,
}: {
  lifecycle: SkillLifecycle;
  /** The popover already has a title that names the status; a tooltip has none. */
  showTitle?: boolean;
}) {
  const styles = useStyles();
  return (
    <span className={styles.tipBody}>
      <span>
        {showTitle ? <strong>Status: {LIFECYCLE_LABELS[lifecycle]}. </strong> : null}
        {LIFECYCLE_MEANING[lifecycle]}
      </span>
      <span>Stages: {LIFECYCLE_STAGES_TEXT}.</span>
    </span>
  );
}

/**
 * A tooltip for something that is not itself focusable (a badge inside a card): the pointer gets the explanation, and the
 * same words are always one click away on the skill's own page. Keyboard users tab through a card once, by its link.
 */
export function Tip({ content, children }: { content: ReactNode; children: ReactNode }) {
  const styles = useStyles();
  return (
    <Tooltip content={content}>
      <span className={styles.tip}>{children}</span>
    </Tooltip>
  );
}

export interface InfoPillProps {
  /** The badge that is shown (a `Badge`, `LifecycleBadge`...). */
  children: ReactNode;
  /** The pill's accessible name: it contains the visible word, then what opening it gives ("Published: what this means"). */
  label: string;
  title: string;
  /** The explanation: opens on a click, on Enter and on a tap; Escape closes it. */
  content: ReactNode;
}

/**
 * A badge that explains itself: the pill is a button that opens a small popover (the same pattern as the demo-data pill
 * of the shell), so a keyboard and a touch screen get the explanation too. A pointer gets the pill's name as a hint.
 */
export function InfoPill({ children, label, title, content }: InfoPillProps) {
  const styles = useStyles();
  return (
    <Popover positioning="below-start">
      <PopoverTrigger disableButtonEnhancement>
        <button type="button" className={styles.pill} aria-label={label} title={label}>
          {children}
        </button>
      </PopoverTrigger>
      <PopoverSurface className={styles.surface} aria-label={title}>
        <p className={styles.popTitle}>{title}</p>
        <div className={styles.popBody}>{content}</div>
      </PopoverSurface>
    </Popover>
  );
}

/** "Estimated": a model estimate with a range, never a measurement. The pill says so; its popover says how. */
export function EstimatedPill({ children }: { children?: ReactNode }) {
  return (
    <InfoPill
      label="Estimated: what this means"
      title="Estimated"
      content={children ?? DEFAULT_ESTIMATE}
    >
      <Badge tone="neutral" icon={<CalculatorIcon />} dotted size="sm">
        Estimated
      </Badge>
    </InfoPill>
  );
}

const DEFAULT_ESTIMATE = (
  <p>A model estimate with a range, not a measured fact. It is never shown as a measurement.</p>
);

/** "Simulated": the result of a what-if replay, not something that happened. */
export function SimulatedPill() {
  return (
    <InfoPill
      label="Simulated: what this means"
      title="Simulated"
      content={
        <p>
          A what-if: the skill was replayed on its source case. Nothing was run on a real system and
          nothing about the case changed.
        </p>
      }
    >
      <Badge tone="simulated" icon={<FlaskConicalIcon />} dashed size="sm">
        Simulated
      </Badge>
    </InfoPill>
  );
}

/** "Demo data": the figures come from fictional cases. The popover carries the full sentence. */
export function DemoPill({ children }: { children: ReactNode }) {
  return (
    <InfoPill label="Demo data in this skill: what this means" title="Demo data" content={children}>
      <Badge tone="neutral" icon={<InfoIcon />} outlined size="sm">
        Demo data
      </Badge>
    </InfoPill>
  );
}
