'use client';

import { StatusBadge, cg } from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import type { TrustView } from './trust';

const useStyles = makeStyles({
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    minWidth: 0,
    padding: cg.space[3],
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surfaceSunken,
  },
  badges: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  text: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
    overflowWrap: 'anywhere',
  },
  meta: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  strong: { color: cg.text, fontWeight: tokens.fontWeightSemibold },
  details: { fontSize: tokens.fontSizeBase300, color: cg.textSecondary },
  summary: {
    cursor: 'pointer',
    color: cg.textLink,
    fontWeight: tokens.fontWeightSemibold,
    minHeight: '24px',
  },
  group: { display: 'flex', flexDirection: 'column', gap: cg.space[1], marginTop: cg.space[3] },
  heading: { margin: 0, fontWeight: tokens.fontWeightSemibold, color: cg.text },
  list: {
    margin: 0,
    paddingLeft: cg.space[4],
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
  },
});

function Group({ title, items }: { title: string; items: readonly string[] }) {
  const styles = useStyles();
  if (items.length === 0) return null;
  return (
    <div className={styles.group}>
      <p className={styles.heading}>{title}</p>
      <ul className={styles.list}>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * How far to trust a simulated path: what its figures rest on, whether it could have been followed, and what to check
 * before relying on it. One line and two badges up front; the detail is one click away and closed by default.
 */
export function TrustPanel({ trust }: { trust: TrustView }) {
  const styles = useStyles();
  return (
    <div className={styles.panel} role="group" aria-label="How far to trust this path">
      <div className={styles.badges}>
        <StatusBadge status={trust.basisBadge} label={trust.basisLabel} />
        <StatusBadge status={trust.feasibilityBadge} label={trust.feasibilityLabel} />
      </div>
      <p className={styles.text}>{trust.summary}</p>
      <p className={styles.meta}>{trust.claimText}</p>
      <details className={styles.details}>
        <summary className={styles.summary}>
          What it rests on, what limits it and what to check
        </summary>
        <Group
          title="What each figure rests on"
          items={trust.parts.map((part) => `${part.what}: ${part.basisLabel}. ${part.note}`)}
        />
        <Group title="Whether it could have been done" items={trust.feasibilityReasons} />
        <Group title="What limits it" items={trust.constraints} />
        <Group title="What to check before relying on it" items={trust.validation} />
        <div className={styles.group}>
          <p className={styles.heading}>Reusable skills</p>
          <p className={styles.text}>
            <span className={styles.strong}>{trust.skill.label}.</span> {trust.skill.note}
          </p>
          {trust.skill.skills.length > 0 ? (
            <ul className={styles.list}>
              {trust.skill.skills.map((skill) => (
                <li key={skill.name}>
                  {skill.name}: {skill.coverageText}
                  {skill.recommendsFirstStep ? '; recommends the same first step' : ''}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </details>
    </div>
  );
}
