'use client';

import { ROLE_LABELS, type Permission } from '@caseguard/schemas';
import { LoadingSkeleton, Notice, cg, useButtonClassName } from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { ChevronDownIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { QueryErrorState } from '../../../components/common/QueryErrorState';
import { useSession } from '../../../lib/auth/session';
import type { Handle } from '../hooks';
import type { MethodNote } from '../model/method';
import { permissionSentence } from '../model/permissions';

const useStyles = makeStyles({
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[6],
    minWidth: 0,
    padding: cg.space[8],
    borderRadius: cg.radius.xl,
    border: `1px solid ${cg.glassBorder}`,
    backgroundColor: cg.glass,
    backdropFilter: 'blur(12px) saturate(1.1)',
    boxShadow: `inset 0 1px 0 ${cg.highlight}, ${cg.shadowLow}`,
    color: cg.text,
    outlineStyle: 'none',
    // Anchors land below the shell header and the sticky section navigation.
    scrollMarginTop: 'calc(var(--cg-shell-top, 84px) + 64px)',
    '@media (max-width: 639px)': { padding: cg.space[4], borderRadius: cg.radius.lg },
  },
  head: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: `${cg.space[2]} ${cg.space[4]}`,
  },
  titleBlock: { display: 'flex', flexDirection: 'column', gap: cg.space[1], minWidth: 0 },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase500,
    lineHeight: tokens.lineHeightBase500,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.015em',
    color: cg.text,
  },
  description: {
    margin: 0,
    maxWidth: '72ch',
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
  },
  badges: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  method: {
    borderTop: `1px solid ${cg.borderSubtle}`,
    paddingTop: cg.space[3],
    fontSize: tokens.fontSizeBase300,
    color: cg.textSecondary,
  },
  summary: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: cg.space[1],
    cursor: 'pointer',
    minHeight: '32px',
    '@media (pointer: coarse)': { minHeight: '44px' },
    color: cg.textSecondary,
    fontWeight: tokens.fontWeightMedium,
    fontSize: tokens.fontSizeBase300,
    listStyleType: 'none',
    ':hover': { color: cg.text },
    ':focus-visible': {
      outline: `2px solid ${cg.focus}`,
      outlineOffset: '2px',
      borderRadius: cg.radius.sm,
    },
    '::-webkit-details-marker': { display: 'none' },
  },
  chevron: { transitionProperty: 'transform', transitionDuration: cg.motion.fast },
  notes: { display: 'flex', flexDirection: 'column', gap: cg.space[3], paddingTop: cg.space[2] },
  noteHeading: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
  },
  paragraph: { margin: `${cg.space[1]} 0 0`, lineHeight: tokens.lineHeightBase300 },
  facts: {
    display: 'grid',
    gridTemplateColumns: 'max-content minmax(0, 1fr)',
    gap: `${cg.space[1]} ${cg.space[4]}`,
    margin: `${cg.space[2]} 0 0`,
  },
  term: { color: cg.textMuted },
  value: { margin: 0, overflowWrap: 'anywhere' },
  toggle: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: cg.space[2],
    maxWidth: '100%',
    margin: 0,
    padding: 0,
    border: 'none',
    backgroundColor: 'transparent',
    color: 'inherit',
    font: 'inherit',
    letterSpacing: 'inherit',
    textAlign: 'start',
    cursor: 'pointer',
    borderRadius: cg.radius.sm,
    '@media (pointer: coarse)': { minHeight: '44px' },
    ':hover': { color: cg.textLink },
    ':focus-visible': { outline: `2px solid ${cg.focus}`, outlineOffset: '4px' },
  },
  toggleIcon: {
    flexShrink: 0,
    color: cg.textMuted,
    transitionProperty: 'transform',
    transitionDuration: cg.motion.fast,
    transitionTimingFunction: cg.motion.easing,
  },
  toggleIconOpen: { transform: 'rotate(180deg)' },
  body: { display: 'flex', flexDirection: 'column', gap: cg.space[6], minWidth: 0 },
  bodyClosed: { display: 'none' },
});

/** The event that asks a closed section to open, sent when the section navigation or a link points at it. */
const OPEN_EVENT = 'cg-section-open';

export interface SectionFrameProps {
  /** The fragment the section navigation links to. */
  id: string;
  title: string;
  description?: ReactNode;
  badges?: ReactNode;
  /** The "How this was calculated" notes of this section. */
  method?: readonly MethodNote[];
  /** Detail on demand: the section starts closed and its heading is the button that opens it. */
  collapsible?: boolean;
  children: ReactNode;
}

/**
 * One section of the review: a named region (a landmark), with its heading, an optional line of explanation, badges
 * that say what kind of figure it shows, its own content states, and its own "How this was calculated" disclosure.
 * A collapsible section keeps its content mounted while closed, so what it read is not lost and opening it is instant.
 */
export function SectionFrame({
  id,
  title,
  description,
  badges,
  method,
  collapsible = false,
  children,
}: SectionFrameProps) {
  const styles = useStyles();
  const headingId = useId();
  const bodyId = useId();
  const [open, setOpen] = useState(!collapsible);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node || !collapsible) return undefined;
    const openIt = (): void => setOpen(true);
    node.addEventListener(OPEN_EVENT, openIt);
    return () => node.removeEventListener(OPEN_EVENT, openIt);
  }, [collapsible]);
  const closed = collapsible && !open;
  return (
    <section ref={ref} id={id} aria-labelledby={headingId} tabIndex={-1} className={styles.section}>
      <div className={styles.head}>
        <div className={styles.titleBlock}>
          <h2 id={headingId} className={styles.title}>
            {collapsible ? (
              <button
                type="button"
                className={styles.toggle}
                aria-expanded={open}
                aria-controls={bodyId}
                onClick={() => setOpen((value) => !value)}
              >
                {title}
                <ChevronDownIcon
                  aria-hidden="true"
                  className={mergeClasses(styles.toggleIcon, open && styles.toggleIconOpen)}
                />
              </button>
            ) : (
              title
            )}
          </h2>
          {description ? <p className={styles.description}>{description}</p> : null}
        </div>
        {badges ? <div className={styles.badges}>{badges}</div> : null}
      </div>
      <div
        id={bodyId}
        hidden={closed}
        className={mergeClasses(styles.body, closed && styles.bodyClosed)}
      >
        {children}
        {method && method.length > 0 ? <MethodDisclosure notes={method} /> : null}
      </div>
    </section>
  );
}

/** "How this was calculated", in plain language, one disclosure per part of the review and one for the whole review. */
export function MethodDisclosure({
  notes,
  summary = 'How this was calculated',
  className,
}: {
  notes: readonly MethodNote[];
  summary?: string;
  className?: string;
}) {
  const styles = useStyles();
  return (
    <details className={mergeClasses(styles.method, className)}>
      <summary className={styles.summary}>
        {summary}
        <ChevronDownIcon aria-hidden="true" className={styles.chevron} />
      </summary>
      <div className={styles.notes}>
        {notes.map((note) => (
          <div key={note.heading}>
            <h3 className={styles.noteHeading}>{note.heading}</h3>
            {note.paragraphs.map((paragraph) => (
              <p key={paragraph} className={styles.paragraph}>
                {paragraph}
              </p>
            ))}
            {note.facts.length > 0 ? (
              <dl className={styles.facts}>
                {note.facts.map((fact) => (
                  <div key={fact.label} style={{ display: 'contents' }}>
                    <dt className={styles.term}>{fact.label}</dt>
                    <dd className={styles.value}>{fact.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>
        ))}
      </div>
    </details>
  );
}

/**
 * Moves focus to a section after the browser scrolled to its anchor, so a keyboard or screen-reader user starts there.
 * A section that is closed is opened first, so what the link points at is on screen.
 */
export function focusSection(id: string): void {
  window.setTimeout(() => {
    const section = document.getElementById(id);
    if (!section) return;
    section.dispatchEvent(new Event(OPEN_EVENT));
    section.focus({ preventScroll: true });
  }, 0);
}

/** A link to another section of the same page, styled as a button. */
export function SectionLink({
  to,
  children,
  appearance = 'outline',
}: {
  to: string;
  children: ReactNode;
  appearance?: 'primary' | 'outline' | 'subtle';
}) {
  const className = useButtonClassName({
    variant: appearance === 'primary' ? 'primary' : appearance === 'subtle' ? 'ghost' : 'secondary',
  });
  return (
    <a href={`#${to}`} className={className} onClick={() => focusSection(to)}>
      {children}
    </a>
  );
}

/** Who can see what is in `../model/permissions`; the sentence that says a part is not shown is built here. */

/** The role names of the person looking, for the sentence that says why something is not shown. */
export function useRoleText(): string {
  const { roles } = useSession();
  return roles.map((role) => ROLE_LABELS[role]).join(', ') || 'none';
}

/** Says, as a state and not as an error, that a part is not shown because the role lacks a permission. */
export function PermissionPart({
  permission,
  what,
  several = false,
}: {
  permission: Permission;
  what: string;
  /** True when `what` names more than one thing. */
  several?: boolean;
}) {
  const role = useRoleText();
  return (
    <Notice variant="info" compact title="Not shown">
      {permissionSentence({ permission, what, role, several })}
    </Notice>
  );
}

/**
 * What a part shows while its read is not ready: a skeleton while loading, the permission note when the role may not read
 * it, an error with a retry when it failed. Renders nothing for a read that is ready: the caller shows the data.
 */
export function PartState({
  handle,
  what,
  skeleton,
}: {
  handle: Handle<unknown>;
  /** What the read is for, as a noun phrase: "the case quality result". */
  what: string;
  skeleton?: ReactNode;
}) {
  const source = handle.source;
  if (source.kind === 'ready') return null;
  if (source.kind === 'loading') {
    return skeleton ?? <LoadingSkeleton variant="text" count={3} label={`Loading ${what}`} />;
  }
  if (source.kind === 'denied')
    return <PermissionPart permission={source.permission} what={what} />;
  return (
    <QueryErrorState
      compact
      subject={`${what.charAt(0).toUpperCase()}${what.slice(1)}`}
      error={source.error}
      onRetry={handle.retry}
      retrying={handle.fetching}
    />
  );
}
