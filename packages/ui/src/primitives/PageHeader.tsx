'use client';

import { makeStyles, tokens } from '@fluentui/react-components';
import type { ReactNode } from 'react';
import { cg } from '../tokens/cg';
import { HelpButton } from './HelpButton';

const useStyles = makeStyles({
  page: { display: 'flex', flexDirection: 'column', gap: cg.space[3], marginBottom: cg.space[6] },
  row: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: `${cg.space[3]} ${cg.space[6]}`,
  },
  titleBlock: {
    minWidth: 0,
    flex: '1 1 320px',
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
  },
  titleLine: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: cg.space[2] },
  h1: {
    margin: 0,
    fontSize: tokens.fontSizeHero700,
    lineHeight: tokens.lineHeightHero700,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
    letterSpacing: '-0.02em',
    overflowWrap: 'anywhere',
    '@media (max-width: 640px)': {
      fontSize: tokens.fontSizeBase600,
      lineHeight: tokens.lineHeightBase600,
    },
  },
  h2: {
    margin: 0,
    fontSize: tokens.fontSizeBase500,
    lineHeight: tokens.lineHeightBase500,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.015em',
    color: cg.text,
  },
  h3: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.01em',
    color: cg.text,
  },
  description: {
    margin: 0,
    maxWidth: '68ch',
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
  },
  actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  meta: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    marginBottom: cg.space[3],
  },
});

export interface PageHeaderProps {
  /** The one `h1` of the page: short, one to three words. */
  title: string;
  /** One line that says what the page is for. */
  description?: ReactNode;
  /** Breadcrumb trail above the title; only where the page has depth (a case, a skill, an Advanced view). */
  breadcrumbs?: ReactNode;
  /** The page's actions, right aligned: at most one primary button, the rest secondary or ghost. */
  actions?: ReactNode;
  /** Contextual help: content of the `?` popover explaining the page and its definitions. */
  help?: ReactNode;
  /** Badges next to the description (Demo data, Estimated...). */
  meta?: ReactNode;
  /** Page navigation under the title (the case workspace's `TabNav`). */
  tabs?: ReactNode;
}

/** Page title block: breadcrumbs slot, `h1`, one-line purpose, badges, actions, tabs and a contextual-help popover. */
export function PageHeader({
  title,
  description,
  breadcrumbs,
  actions,
  help,
  meta,
  tabs,
}: PageHeaderProps) {
  const styles = useStyles();
  return (
    <header className={styles.page}>
      {breadcrumbs}
      <div className={styles.row}>
        <div className={styles.titleBlock}>
          <div className={styles.titleLine}>
            <h1 className={styles.h1}>{title}</h1>
            {help ? (
              <HelpButton label={`About ${title}`} title={title} size="medium">
                {help}
              </HelpButton>
            ) : null}
          </div>
          {description ? <p className={styles.description}>{description}</p> : null}
          {meta ? <div className={styles.meta}>{meta}</div> : null}
        </div>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
      {tabs}
    </header>
  );
}

export interface SectionHeaderProps {
  title: string;
  description?: ReactNode;
  /** Heading level, so the hierarchy stays logical inside cards (default 2). */
  level?: 2 | 3;
  actions?: ReactNode;
  /** Contextual help for the section. */
  help?: ReactNode;
  id?: string;
}

/** Section heading with optional description, actions and help. */
export function SectionHeader({
  title,
  description,
  level = 2,
  actions,
  help,
  id,
}: SectionHeaderProps) {
  const styles = useStyles();
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <div className={styles.section}>
      <div className={styles.row}>
        <div className={styles.titleLine}>
          <Heading id={id} className={level === 2 ? styles.h2 : styles.h3}>
            {title}
          </Heading>
          {help ? (
            <HelpButton label={`About ${title}`} title={title}>
              {help}
            </HelpButton>
          ) : null}
        </div>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
      {description ? <p className={styles.description}>{description}</p> : null}
    </div>
  );
}
