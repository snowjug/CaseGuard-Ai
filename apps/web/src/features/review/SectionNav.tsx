'use client';

import { cg } from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { useState } from 'react';
import { focusSection } from './sections/shared';

/**
 * The sections of the review in reading order: the fragment the section has, the short name the navigation shows and
 * the full title of the section itself.
 */
export const REVIEW_SECTIONS = [
  { id: 'verdict', label: 'Verdict', title: 'Verdict' },
  { id: 'next-actions', label: 'Fix first', title: 'Fix first' },
  { id: 'evidence', label: 'Evidence', title: 'Evidence' },
  { id: 'should-have', label: 'What if', title: 'What would have changed the outcome' },
  { id: 'chronology', label: 'What happened', title: 'What happened' },
  { id: 'decisions', label: 'What went wrong', title: 'What went wrong' },
  { id: 'learning', label: 'What to learn', title: 'What to learn' },
  { id: 'share', label: 'Share', title: 'Share' },
] as const;

const useStyles = makeStyles({
  nav: {
    position: 'sticky',
    top: `calc(var(--cg-shell-top, 56px) + ${cg.space[2]})`,
    zIndex: 2,
    backgroundColor: cg.glass,
    backdropFilter: 'blur(16px) saturate(1.1)',
    border: `1px solid ${cg.glassBorder}`,
    borderRadius: cg.radius.lg,
    overflowX: 'auto',
    maxWidth: '100%',
    '@media print': { display: 'none' },
  },
  list: {
    display: 'flex',
    alignItems: 'center',
    gap: cg.space[1],
    margin: 0,
    padding: cg.space[1],
    listStyleType: 'none',
    minWidth: 'max-content',
  },
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: '36px',
    paddingInline: cg.space[3],
    borderRadius: cg.radius.md,
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightMedium,
    textDecorationLine: 'none',
    whiteSpace: 'nowrap',
    transitionProperty: 'color, background-color',
    transitionDuration: cg.motion.fast,
    ':hover': { color: cg.text, backgroundColor: cg.surfaceSunken },
    ':focus-visible': { outline: `2px solid ${cg.focus}`, outlineOffset: '-2px' },
    '@media (pointer: coarse)': { minHeight: '44px' },
  },
  current: { color: cg.text, backgroundColor: cg.tone.brand.tint },
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
    <nav className={styles.nav} aria-label="Sections of the review">
      <ul className={styles.list}>
        {REVIEW_SECTIONS.map((section) => (
          <li key={section.id}>
            <a
              href={`#${section.id}`}
              title={section.title}
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
