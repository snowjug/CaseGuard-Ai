'use client';

import { ROLE_LABELS, type DemoStep, type Persona } from '@caseguard/schemas';
import { BadgeShell, StatusBadge, cg } from '@caseguard/ui';
import { Button, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  ArrowRightRegular,
  ChevronDownRegular,
  ChevronUpRegular,
  LockClosedRegular,
  PersonSwapRegular,
  PlayRegular,
} from '@fluentui/react-icons';
import { LinkButton } from '../../components/common/LinkButton';
import { safeInternalHref } from '../../lib/safe-href';

const useStyles = makeStyles({
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  card: {
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr)',
    gap: `${cg.space[2]} ${cg.space[4]}`,
    padding: cg.space[4],
    borderRadius: cg.radius.lg,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surface,
    scrollMarginTop: 'calc(var(--cg-shell-top, 84px) + 16px)',
  },
  next: { border: `2px solid ${cg.tone.brand.solid}`, backgroundColor: cg.tone.brand.tint },
  locked: { backgroundColor: cg.surfaceSunken },
  selected: { boxShadow: `0 0 0 3px ${cg.focus}` },
  number: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '36px',
    height: '36px',
    borderRadius: cg.radius.pill,
    border: `2px solid ${cg.borderControl}`,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: 'tabular-nums',
    color: cg.text,
    backgroundColor: cg.surface,
  },
  numberDone: { border: `2px solid ${cg.tone.productive.border}`, color: cg.tone.productive.fg },
  body: { display: 'flex', flexDirection: 'column', gap: cg.space[2], minWidth: 0 },
  head: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: cg.space[2] },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
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
    gap: cg.space[2],
    fontSize: tokens.fontSizeBase200,
    color: cg.textMuted,
  },
  lockedText: {
    margin: 0,
    display: 'flex',
    alignItems: 'center',
    gap: cg.space[2],
    fontSize: tokens.fontSizeBase300,
    color: cg.textSecondary,
  },
  actions: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: cg.space[2] },
  notes: {
    margin: 0,
    padding: `${cg.space[2]} ${cg.space[3]}`,
    borderLeft: `3px solid ${cg.borderControl}`,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.text,
    maxWidth: '78ch',
  },
});

export interface StepListProps {
  steps: readonly DemoStep[];
  /** Step whose presenter notes are open (`?step=`); the next step's notes are always shown. */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** True while presenting: the presenter strip owns role switching, and the next action is outlined. */
  presenting: boolean;
  /** Whether the signed-in identity holds a role. */
  actingAs: (role: DemoStep['persona']) => boolean;
  /** Development persona that holds a role (null when none or when no development identity is in use). */
  personaFor: (role: DemoStep['persona']) => Persona | null;
  onSwitch: (persona: Persona) => void;
}

function StatusOf({ step }: { step: DemoStep }) {
  if (step.completed) return <StatusBadge status="productive" label="Done" />;
  if (step.isNextAction)
    return (
      <BadgeShell
        tone="brand"
        pattern="solid"
        icon={<PlayRegular />}
        label="Next"
        title="The next step to show"
      />
    );
  if (!step.enabled) return <StatusBadge status="missing" label="Locked" />;
  return <StatusBadge status="neutral" label="Available" />;
}

function StepCard({
  step,
  total,
  selected,
  onSelect,
  presenting,
  actingAs,
  personaFor,
  onSwitch,
}: { step: DemoStep; total: number; selected: boolean } & Omit<
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
  return (
    <li
      id={`demo-step-${step.id}`}
      className={mergeClasses(
        styles.card,
        step.isNextAction && styles.next,
        !step.enabled && styles.locked,
        selected && styles.selected,
      )}
      aria-current={step.isNextAction ? 'step' : undefined}
    >
      <span
        className={mergeClasses(styles.number, step.completed && styles.numberDone)}
        aria-hidden="true"
      >
        {step.order}
      </span>
      <div className={styles.body}>
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
          <span>Present as {role}</span>
          {matches ? <span>· you are acting as this role</span> : null}
        </p>
        {!step.enabled && step.lockedReason ? (
          <p className={styles.lockedText}>
            <LockClosedRegular aria-hidden="true" />
            <span>
              <strong>Locked.</strong> {step.lockedReason}
            </span>
          </p>
        ) : null}
        <div className={styles.actions}>
          {step.enabled ? (
            href ? (
              <LinkButton
                href={href}
                appearance="outline"
                icon={<ArrowRightRegular />}
                iconPosition="after"
              >
                {step.actionLabel}
              </LinkButton>
            ) : (
              <Button appearance="outline" disabledFocusable>
                {step.actionLabel} (link unavailable)
              </Button>
            )
          ) : (
            <Button appearance="outline" disabledFocusable>
              {step.actionLabel}
            </Button>
          )}
          {!presenting && step.isNextAction && !matches && persona ? (
            <Button
              appearance="subtle"
              icon={<PersonSwapRegular />}
              onClick={() => onSwitch(persona)}
            >
              {`Switch to ${persona.displayName}`}
            </Button>
          ) : null}
          {!step.isNextAction ? (
            <Button
              appearance="subtle"
              icon={selected ? <ChevronUpRegular /> : <ChevronDownRegular />}
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
            <strong>Presenter notes. </strong>
            {step.presenterNotes}
          </p>
        ) : null}
      </div>
    </li>
  );
}

/** The ordered story. Every flag comes from `demo.state`, which the API derives from stored data: nothing is ticked by hand. */
export function StepList({ steps, selectedId, ...rest }: StepListProps) {
  const styles = useStyles();
  return (
    <ol className={styles.list} aria-label="Demo steps">
      {steps.map((step) => (
        <StepCard
          key={step.id}
          step={step}
          total={steps.length}
          selected={selectedId === step.id}
          {...rest}
        />
      ))}
    </ol>
  );
}
