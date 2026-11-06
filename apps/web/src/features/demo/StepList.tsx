'use client';

import { ROLE_LABELS, type DemoStep, type Persona } from '@caseguard/schemas';
import { Badge, Button, ButtonLink, borderColors, cg } from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  LockIcon,
  PlayIcon,
  UserCogIcon,
  UserRoundIcon,
} from 'lucide-react';
import { StateBadge } from '../../lib/advanced-view-parts';
import { safeInternalHref } from '../../lib/safe-href';

const useStyles = makeStyles({
  list: { display: 'flex', flexDirection: 'column', margin: 0, padding: 0, listStyleType: 'none' },
  step: {
    display: 'grid',
    gridTemplateColumns: '36px minmax(0, 1fr)',
    columnGap: cg.space[4],
    scrollMarginTop: 'calc(var(--cg-shell-top, 84px) + 16px)',
  },
  rail: { display: 'flex', flexDirection: 'column', alignItems: 'center' },
  marker: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: '36px',
    height: '36px',
    borderRadius: cg.radius.pill,
    border: `1px solid ${cg.borderControl}`,
    backgroundColor: cg.surfaceSunken,
    color: cg.text,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: 'tabular-nums',
  },
  markerDone: {
    color: cg.tone.productive.fg,
    backgroundColor: cg.tone.productive.tint,
    ...borderColors(`color-mix(in srgb, ${cg.tone.productive.border} 60%, transparent)`),
    fontSize: tokens.fontSizeBase400,
  },
  markerNext: {
    backgroundImage: cg.gradientAccent,
    color: cg.tone.brand.onSolid,
    ...borderColors('transparent'),
    boxShadow: `0 0 0 4px ${cg.glow}`,
  },
  markerLocked: { color: cg.textMuted, fontSize: tokens.fontSizeBase300 },
  line: {
    flex: '1 1 auto',
    width: '2px',
    minHeight: cg.space[4],
    marginBlock: cg.space[1],
    borderRadius: cg.radius.pill,
    backgroundColor: cg.borderSubtle,
  },
  lineDone: {
    backgroundColor: `color-mix(in srgb, ${cg.tone.productive.border} 55%, transparent)`,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    minWidth: 0,
    paddingBottom: cg.space[6],
  },
  cardNext: {
    padding: cg.space[4],
    marginBottom: cg.space[6],
    borderRadius: cg.radius.lg,
    backgroundColor: `color-mix(in srgb, ${cg.tone.brand.tint} 60%, transparent)`,
    border: `1px solid color-mix(in srgb, ${cg.tone.brand.border} 45%, transparent)`,
    boxShadow: `0 16px 48px -24px ${cg.glow}`,
  },
  cardLast: { paddingBottom: 0 },
  selected: { outline: `2px solid ${cg.focus}`, outlineOffset: '4px', borderRadius: cg.radius.lg },
  head: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: `${cg.space[1]} ${cg.space[2]}`,
  },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.01em',
    color: cg.text,
  },
  text: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
  },
  meta: {
    margin: 0,
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: `${cg.space[1]} ${cg.space[2]}`,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    color: cg.textMuted,
  },
  lockedText: {
    margin: 0,
    display: 'flex',
    alignItems: 'flex-start',
    gap: cg.space[2],
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    color: cg.textSecondary,
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: cg.space[2],
    marginTop: cg.space[1],
  },
  notes: {
    margin: 0,
    padding: `${cg.space[1]} ${cg.space[3]}`,
    borderLeft: `3px solid ${cg.tone.brand.border}`,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
    maxWidth: '78ch',
  },
  noteLabel: { color: cg.text, fontWeight: tokens.fontWeightSemibold },
});

export interface StepListProps {
  steps: readonly DemoStep[];
  /** Step whose presenter notes are open (`?step=`); the next step's notes are always shown. */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** True while presenting: the presenter strip owns role switching. */
  presenting: boolean;
  /** Whether the signed-in identity holds a role. */
  actingAs: (role: DemoStep['persona']) => boolean;
  /** Development persona that holds a role (null when none or when no development identity is in use). */
  personaFor: (role: DemoStep['persona']) => Persona | null;
  onSwitch: (persona: Persona) => void;
}

function StatusOf({ step }: { step: DemoStep }) {
  if (step.completed)
    return <StateBadge status="productive" label="Done" title="The data for this step exists." />;
  if (step.isNextAction)
    return (
      <Badge tone="brand" icon={<PlayIcon />} title="The next step to show">
        Next
      </Badge>
    );
  if (!step.enabled)
    return <StateBadge status="missing" label="Locked" title="Steps unlock in order." />;
  return <StateBadge status="neutral" label="Available" title="Ready to show." />;
}

function StepCard({
  step,
  total,
  last,
  selected,
  onSelect,
  presenting,
  actingAs,
  personaFor,
  onSwitch,
}: { step: DemoStep; total: number; last: boolean; selected: boolean } & Omit<
  StepListProps,
  'steps' | 'selectedId'
>) {
  const styles = useStyles();
  const href = step.enabled ? safeInternalHref(step.route) : null;
  const role = ROLE_LABELS[step.persona];
  const matches = actingAs(step.persona);
  const persona = personaFor(step.persona);
  const notesOpen = step.isNextAction || selected;
  const notesId = `demo-notes-${step.id}`;
  const locked = !step.enabled && !step.completed;
  return (
    <li
      id={`demo-step-${step.id}`}
      className={styles.step}
      aria-current={step.isNextAction ? 'step' : undefined}
    >
      <div className={styles.rail} aria-hidden="true">
        <span
          className={mergeClasses(
            styles.marker,
            step.completed && styles.markerDone,
            step.isNextAction && !step.completed && styles.markerNext,
            locked && styles.markerLocked,
          )}
        >
          {step.completed ? <CheckIcon /> : locked ? <LockIcon /> : step.order}
        </span>
        {last ? null : (
          <span className={mergeClasses(styles.line, step.completed && styles.lineDone)} />
        )}
      </div>
      <div
        className={mergeClasses(
          styles.card,
          step.isNextAction && styles.cardNext,
          last && !step.isNextAction && styles.cardLast,
          selected && styles.selected,
        )}
      >
        <div className={styles.head}>
          <h3 className={styles.title}>
            <span className="cg-sr-only">
              Step {step.order} of {total}:{' '}
            </span>
            {step.title}
          </h3>
          <StatusOf step={step} />
        </div>
        <p className={styles.text}>{step.description}</p>
        <p className={styles.meta}>
          <UserRoundIcon aria-hidden="true" />
          <span>Present as {role}</span>
          {matches ? <span>· you are acting as this role</span> : null}
        </p>
        {!step.enabled && step.lockedReason ? (
          <p className={styles.lockedText}>
            <LockIcon aria-hidden="true" />
            <span>
              <strong>Locked.</strong> {step.lockedReason}
            </span>
          </p>
        ) : null}
        <div className={styles.actions}>
          {step.enabled ? (
            href ? (
              <ButtonLink
                href={href}
                variant="secondary"
                size="sm"
                icon={<ArrowRightIcon />}
                iconPosition="end"
              >
                {step.actionLabel}
              </ButtonLink>
            ) : (
              <Button variant="secondary" size="sm" disabledFocusable>
                {step.actionLabel} (link unavailable)
              </Button>
            )
          ) : (
            <Button variant="secondary" size="sm" disabledFocusable>
              {step.actionLabel}
            </Button>
          )}
          {!presenting && step.isNextAction && !matches && persona ? (
            <Button
              variant="ghost"
              size="sm"
              icon={<UserCogIcon />}
              onClick={() => onSwitch(persona)}
            >
              {`Switch to ${persona.displayName}`}
            </Button>
          ) : null}
          {!step.isNextAction ? (
            <Button
              variant="ghost"
              size="sm"
              icon={selected ? <ChevronUpIcon /> : <ChevronDownIcon />}
              aria-expanded={selected}
              aria-controls={notesId}
              onClick={() => onSelect(selected ? null : step.id)}
            >
              Presenter notes
            </Button>
          ) : null}
        </div>
        {notesOpen ? (
          <p id={notesId} className={styles.notes}>
            <strong className={styles.noteLabel}>Presenter notes. </strong>
            {step.presenterNotes}
          </p>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The story as a vertical stepper: a marker per step (a check when done, the number when it can be shown, a lock when it
 * cannot yet), the next step highlighted. Every flag comes from `demo.state`, which the API derives from stored data:
 * nothing is ticked by hand.
 */
export function StepList({ steps, selectedId, ...rest }: StepListProps) {
  const styles = useStyles();
  return (
    <ol className={styles.list} aria-label="Demo steps">
      {steps.map((step, index) => (
        <StepCard
          key={step.id}
          step={step}
          total={steps.length}
          last={index === steps.length - 1}
          selected={selectedId === step.id}
          {...rest}
        />
      ))}
    </ol>
  );
}
