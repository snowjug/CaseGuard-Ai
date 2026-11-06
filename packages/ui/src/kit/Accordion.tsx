'use client';

import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { ChevronDownIcon } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { cg } from '../tokens/cg';

const useStyles = makeStyles({
  item: {
    borderBottom: `1px solid ${cg.borderSubtle}`,
    ':last-child': { borderBottom: 0 },
  },
  heading: { margin: 0, fontSize: 'inherit' },
  trigger: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    gap: cg.space[3],
    minHeight: '56px',
    padding: `${cg.space[3]} ${cg.space[1]}`,
    border: 0,
    backgroundColor: 'transparent',
    color: cg.text,
    textAlign: 'start',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: tokens.fontSizeBase300,
    ':hover': { color: cg.tone.brand.fg },
    ':focus-visible': {
      outline: `2px solid ${cg.focus}`,
      outlineOffset: '-2px',
      borderRadius: cg.radius.sm,
    },
  },
  icon: { display: 'inline-flex', color: cg.textSecondary, fontSize: '1.25em' },
  titles: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    minWidth: 0,
    flex: '1 1 auto',
  },
  title: { fontWeight: tokens.fontWeightSemibold },
  subtitle: {
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightRegular,
  },
  chevron: {
    flexShrink: 0,
    color: cg.textSecondary,
    transitionProperty: 'transform',
    transitionDuration: cg.motion.base,
    transitionTimingFunction: cg.motion.easing,
  },
  chevronOpen: { transform: 'rotate(180deg)' },
  // The panel grows by animating its grid row from 0fr to 1fr: smooth, and no height measuring in JavaScript.
  panel: {
    display: 'grid',
    gridTemplateRows: '0fr',
    transitionProperty: 'grid-template-rows',
    transitionDuration: cg.motion.base,
    transitionTimingFunction: cg.motion.easing,
  },
  panelOpen: { gridTemplateRows: '1fr' },
  inner: { minHeight: 0, overflow: 'hidden' },
  content: { paddingBottom: cg.space[4], paddingInline: cg.space[1] },
  group: { display: 'flex', flexDirection: 'column' },
});

export interface AccordionProps {
  children: ReactNode;
  className?: string;
}

/** A stack of `AccordionItem`s separated by hairlines. */
export function Accordion({ children, className }: AccordionProps) {
  const styles = useStyles();
  return <div className={mergeClasses(styles.group, className)}>{children}</div>;
}

export interface AccordionItemProps {
  title: ReactNode;
  /** One quiet line under the title (a count, a status). */
  subtitle?: ReactNode;
  icon?: ReactNode;
  /** Shown at the end of the header (a count badge). */
  badge?: ReactNode;
  /** Heading level of the title, so the page outline stays logical (default 3). */
  headingLevel?: 2 | 3 | 4;
  defaultOpen?: boolean;
  /** Controlled state; pair it with `onOpenChange`. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Mount the content only after the first time it is opened (default), so closed sections cost nothing. */
  lazy?: boolean;
  children: ReactNode;
}

/**
 * A disclosure: a heading-wrapped button (`aria-expanded`) that opens a region. Closed content is `inert`, so it can
 * neither be focused nor read, and it opens with a 200 ms height transition (none with reduced motion).
 */
export function AccordionItem({
  title,
  subtitle,
  icon,
  badge,
  headingLevel = 3,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  lazy = true,
  children,
}: AccordionItemProps) {
  const styles = useStyles();
  const id = useId();
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const open = controlledOpen ?? internalOpen;
  const [everOpened, setEverOpened] = useState(open);
  // Adjusting state while rendering (not in an effect) is React's pattern for "remember that it was opened once".
  if (open && !everOpened) setEverOpened(true);
  const Heading = `h${headingLevel}` as const;

  const toggle = (): void => {
    const next = !open;
    if (controlledOpen === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };

  return (
    <div className={styles.item}>
      <Heading className={styles.heading}>
        <button
          type="button"
          id={`${id}-trigger`}
          aria-expanded={open}
          aria-controls={`${id}-panel`}
          className={styles.trigger}
          onClick={toggle}
        >
          {icon ? (
            <span aria-hidden="true" className={styles.icon}>
              {icon}
            </span>
          ) : null}
          <span className={styles.titles}>
            <span className={styles.title}>{title}</span>
            {subtitle ? <span className={styles.subtitle}>{subtitle}</span> : null}
          </span>
          {badge}
          <ChevronDownIcon
            aria-hidden="true"
            className={mergeClasses(styles.chevron, open && styles.chevronOpen)}
          />
        </button>
      </Heading>
      <div
        id={`${id}-panel`}
        role="region"
        aria-labelledby={`${id}-trigger`}
        inert={!open}
        className={mergeClasses(styles.panel, open && styles.panelOpen)}
      >
        <div className={styles.inner}>
          <div className={styles.content}>{!lazy || everOpened ? children : null}</div>
        </div>
      </div>
    </div>
  );
}
