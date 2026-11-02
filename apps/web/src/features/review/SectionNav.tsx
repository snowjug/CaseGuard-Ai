'use client';

import { cg } from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { useState } from 'react';
import { focusSection } from './sections/shared';

/** The sections of the guided review in reading order: the fragment the section has, and the name a person sees. */
export const REVIEW_SECTIONS = [
  { id: 'verdict', label: 'Verdict' },
  { id: 'chronology', label: 'Chronology' },
  { id: 'decisions', label: 'What went wrong' },
  { id: 'should-have', label: 'What should have happened' },
  { id: 'next-actions', label: 'Next actions' },
  { id: 'learning', label: 'Learning' },
  { id: 'share', label: 'Share' },
] as const;

const useStyles = makeStyles({
  nav: {
    position: 'sticky',
    top: 'var(--cg-shell-top, 84px)',
    zIndex: 2,
    backgroundColor: cg.surface,
    border: `1px solid ${cg.borderSubtle}`,
    borderRadius: cg.radius.md,
    boxShadow: cg.shadowLow,
    overflowX: 'auto',
    maxWidth: '100%',
  },
  list: {
    display: 'flex',
    alignItems: 'center',
    gap: cg.space[1],
    margin: 0,
    padding: cg.space[1],
    listStyle: 'none',
    minWidth: 'max-content',
  },
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: '32px',
    paddingInline: cg.space[3],
    borderRadius: cg.radius.sm,
    color: cg.text,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    textDecorationLine: 'none',
    whiteSpace: 'nowrap',
    ':hover': { backgroundColor: cg.surfaceSunken, textDecorationLine: 'underline' },
  },
  current: { backgroundColor: cg.surfaceSunken, boxShadow: `inset 0 -3px 0 ${cg.textLink}` },
});

/**
 * "On this page": a link to every section, always in reach. Following one scrolls to the section and moves focus to it,
 * so a keyboard or screen-reader user continues reading there. It is plain links (no widget to learn), and it scrolls
 * sideways on a narrow screen instead of wrapping over the content.
 */
export function SectionNav() {
  const styles = useStyles();
  const [current, setCurrent] = useState<string | null>(null);
  return (
    <nav className={styles.nav} aria-label="Sections of the guided review">
      <ul className={styles.list}>
        {REVIEW_SECTIONS.map((section) => (
          <li key={section.id}>
            <a
              href={`#${section.id}`}
              className={mergeClasses(styles.link, current === section.id && styles.current)}
              aria-current={current === section.id ? 'location' : undefined}
              onClick={() => {
                setCurrent(section.id);
                focusSection(section.id);
              }}
            >
              {section.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
