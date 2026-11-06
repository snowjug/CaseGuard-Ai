'use client';

import {
  Popover,
  PopoverSurface,
  PopoverTrigger,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { CircleHelpIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { IconButton } from '../kit/Button';
import { cg } from '../tokens/cg';

const useStyles = makeStyles({
  surface: {
    maxWidth: '340px',
    padding: cg.space[4],
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.text,
    backgroundColor: cg.surfaceRaised,
    border: `1px solid ${cg.glassBorder}`,
    borderRadius: cg.radius.md,
    boxShadow: cg.shadowHigh,
  },
  title: {
    margin: `0 0 ${cg.space[2]}`,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
  },
  body: { margin: 0, color: cg.textSecondary },
  formulaLabel: {
    margin: `${cg.space[3]} 0 ${cg.space[1]}`,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.textMuted,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  formula: {
    display: 'block',
    margin: 0,
    padding: `${cg.space[2]} ${cg.space[3]}`,
    borderRadius: cg.radius.sm,
    backgroundColor: cg.surfaceSunken,
    fontFamily: cg.font.mono,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  note: { margin: `${cg.space[3]} 0 0`, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
});

export interface HelpButtonProps {
  /** Accessible name of the trigger, for example "About Command Center". */
  label: string;
  /** Heading inside the popover. */
  title?: string;
  /** Popover content. Keep it to a short paragraph or two. */
  children: ReactNode;
  size?: 'small' | 'medium';
}

/**
 * Icon button that opens a non-modal explanatory popover (Esc closes it and focus returns to the button).
 * Used for page help and metric definitions.
 */
export function HelpButton({ label, title, children, size = 'small' }: HelpButtonProps) {
  const styles = useStyles();
  return (
    <Popover positioning="below-start" withArrow>
      <PopoverTrigger disableButtonEnhancement>
        <IconButton
          icon={<CircleHelpIcon />}
          label={label}
          size={size === 'small' ? 'sm' : 'md'}
          tooltip={false}
          title={label}
        />
      </PopoverTrigger>
      <PopoverSurface className={styles.surface} aria-label={title ?? label}>
        {title ? <p className={styles.title}>{title}</p> : null}
        <div className={styles.body}>{children}</div>
      </PopoverSurface>
    </Popover>
  );
}

export interface DefinitionPopoverProps {
  /** The term being defined, for example "Case Quality Index". */
  term: string;
  /** Plain-language definition. */
  definition: string;
  /** Compact formula (never presented as a scientific law). */
  formula?: string | null;
  /** Extra caveat, for example that the value is a model estimate. */
  note?: ReactNode;
  size?: 'small' | 'medium';
}

/** Help button specialised for metric / term definitions with an optional formula. */
export function DefinitionPopover({
  term,
  definition,
  formula,
  note,
  size = 'small',
}: DefinitionPopoverProps) {
  const styles = useStyles();
  return (
    <Popover positioning="below-start" withArrow>
      <PopoverTrigger disableButtonEnhancement>
        <IconButton
          icon={<CircleHelpIcon />}
          label={`What is ${term}?`}
          size={size === 'small' ? 'sm' : 'md'}
          tooltip={false}
          title={`What is ${term}?`}
        />
      </PopoverTrigger>
      <PopoverSurface className={styles.surface} aria-label={`Definition of ${term}`}>
        <p className={styles.title}>{term}</p>
        <p className={styles.body}>{definition}</p>
        {formula ? (
          <>
            <p className={styles.formulaLabel}>How it is calculated</p>
            <code className={styles.formula}>{formula}</code>
          </>
        ) : null}
        {note ? <p className={styles.note}>{note}</p> : null}
      </PopoverSurface>
    </Popover>
  );
}
