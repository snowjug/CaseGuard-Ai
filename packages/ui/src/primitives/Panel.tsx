'use client';

import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { useId, type CSSProperties, type ReactNode } from 'react';
import { cg } from '../tokens/cg';
import type { ToneName } from '../tokens/palette';
import { HelpButton } from './HelpButton';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    minWidth: 0,
    padding: cg.space[4],
    borderRadius: cg.radius.lg,
    backgroundColor: cg.surface,
    border: `1px solid ${cg.borderSubtle}`,
    boxShadow: cg.shadowLow,
    color: cg.text,
  },
  head: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: cg.space[3],
    flexWrap: 'wrap',
  },
  titleBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    minWidth: 0,
    flex: '1 1 auto',
  },
  titleLine: { display: 'flex', alignItems: 'center', gap: cg.space[1] },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
  },
  description: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
  },
  actions: { display: 'flex', alignItems: 'center', gap: cg.space[2], flexWrap: 'wrap' },
  body: { display: 'flex', flexDirection: 'column', gap: cg.space[3], minWidth: 0 },
  footer: {
    marginTop: 'auto',
    paddingTop: cg.space[3],
    borderTop: `1px solid ${cg.borderSubtle}`,
    display: 'flex',
    flexWrap: 'wrap',
    gap: cg.space[3],
    alignItems: 'center',
  },
});

export interface PanelProps {
  /** Heading text. Every panel has a visible heading so the page outline stays navigable. */
  title: string;
  /** Heading level (default 2; use 3 when nested inside another section). */
  level?: 2 | 3;
  /** One line that says what the panel shows or why it matters. */
  description?: ReactNode;
  /** Contextual help: content of the `?` popover (definitions, caveats). */
  help?: ReactNode;
  /** Right-aligned header controls (a button or link). */
  actions?: ReactNode;
  /** Bottom row, for example a "View all" link. */
  footer?: ReactNode;
  /** Draws a restrained accent edge in the tone's colour: the visual grammar's meaning, never decoration. */
  accent?: ToneName;
  children: ReactNode;
  className?: string;
  /** Extra class for the content area. */
  bodyClassName?: string;
}

/**
 * Content panel: a labelled `group` with a heading, optional help, actions and footer. Use it for every card-like
 * section of a page so spacing, headings and the help popover are consistent.
 */
export function Panel({
  title,
  level = 2,
  description,
  help,
  actions,
  footer,
  accent,
  children,
  className,
  bodyClassName,
}: PanelProps) {
  const styles = useStyles();
  const headingId = useId();
  const Heading = level === 2 ? 'h2' : 'h3';
  const style: CSSProperties | undefined = accent
    ? { boxShadow: `inset 4px 0 0 ${cg.tone[accent].solid}, ${cg.shadowLow}` }
    : undefined;
  return (
    <div
      role="group"
      aria-labelledby={headingId}
      className={mergeClasses(styles.root, className)}
      style={style}
    >
      <div className={styles.head}>
        <div className={styles.titleBlock}>
          <div className={styles.titleLine}>
            <Heading id={headingId} className={styles.title}>
              {title}
            </Heading>
            {help ? (
              <HelpButton label={`About ${title}`} title={title}>
                {help}
              </HelpButton>
            ) : null}
          </div>
          {description ? <p className={styles.description}>{description}</p> : null}
        </div>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
      <div className={mergeClasses(styles.body, bodyClassName)}>{children}</div>
      {footer ? <div className={styles.footer}>{footer}</div> : null}
    </div>
  );
}
