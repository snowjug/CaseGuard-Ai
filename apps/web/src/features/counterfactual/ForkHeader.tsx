'use client';

import type { DecisionFork } from '@caseguard/schemas';
import { FORK_CATEGORY_LABELS } from '@caseguard/schemas';
import {
  Badge,
  HelpButton,
  ProvenanceBadge,
  StatusBadge,
  UiLink,
  cg,
  formatDateTimeUtc,
  formatProbability,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { StarIcon } from 'lucide-react';
import { useId } from 'react';
import { ExpandableText } from '../../components/case/ExpandableText';
import { caseHref, evidenceLinkHref } from '../../lib/deep-links';
import { LEVEL_LABELS, SEVERITY_BADGES } from '../reasoning/labels';
import { instantBefore } from '../reasoning/time';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: cg.space[3], minWidth: 0 },
  eyebrow: {
    margin: 0,
    color: cg.textMuted,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightMedium,
  },
  titleLine: { display: 'flex', alignItems: 'flex-start', gap: cg.space[1] },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.01em',
    overflowWrap: 'anywhere',
  },
  badges: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  text: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
    overflowWrap: 'anywhere',
  },
  muted: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  footer: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${cg.space[2]} ${cg.space[6]}`,
    paddingTop: cg.space[4],
    borderTop: `1px solid ${cg.borderSubtle}`,
  },
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: '24px',
    color: cg.textLink,
    fontSize: tokens.fontSizeBase300,
    textDecorationLine: 'underline',
    textUnderlineOffset: '2px',
    '@media (pointer: coarse)': { minHeight: '44px' },
  },
});

const HELP =
  'A key decision is a moment where a better path was available. The summary says why this one was flagged. Everything on this screen about it uses only what was known at its decision instant, except the part labelled Known only later.';

export interface ForkHeaderProps {
  fork: DecisionFork;
}

/** The chosen key decision: what it was and why it was flagged. */
export function ForkHeader({ fork }: ForkHeaderProps) {
  const styles = useStyles();
  const headingId = useId();
  const severity = SEVERITY_BADGES[fork.severity];
  return (
    <section className={styles.root} aria-labelledby={headingId}>
      <p className={styles.eyebrow}>The decision</p>
      <div className={styles.titleLine}>
        <h3 id={headingId} className={styles.title}>
          {fork.title}
        </h3>
        <HelpButton label="About this key decision" title="Key decision">
          {HELP}
        </HelpButton>
      </div>
      <ExpandableText text={fork.summary} lines={3} label="decision summary" />
      <div className={styles.badges}>
        {fork.isEarliestMeaningful ? (
          <Badge tone="brand" icon={<StarIcon />}>
            Earliest meaningful decision
          </Badge>
        ) : null}
        <StatusBadge status={severity.status} label={severity.label} size="small" />
        <ProvenanceBadge kind="estimated" label={`Impact ${formatProbability(fork.impactScore)}`} />
      </div>
      <p className={styles.text}>
        <strong>{FORK_CATEGORY_LABELS[fork.category]}</strong>
        {fork.additionalCategories.length > 0
          ? `; also: ${fork.additionalCategories.map((c) => FORK_CATEGORY_LABELS[c]).join('; ')}`
          : ''}
        . Risk of the step taken: {LEVEL_LABELS[fork.risk]}.
      </p>
    </section>
  );
}

export interface ForkLinksProps {
  caseId: string;
  fork: DecisionFork;
}

/** When the decision happened and how to see that moment on the other pages. */
export function ForkLinks({ caseId, fork }: ForkLinksProps) {
  const styles = useStyles();
  return (
    <div className={styles.footer}>
      <p className={styles.muted}>Decision at {formatDateTimeUtc(fork.timestamp)}</p>
      <UiLink
        className={styles.link}
        href={`${caseHref(caseId, 'hypotheses')}?asOf=${encodeURIComponent(instantBefore(fork.timestamp))}`}
      >
        See possible causes just before this decision
      </UiLink>
      <UiLink
        className={styles.link}
        href={evidenceLinkHref(caseId, { type: 'event', id: fork.eventId })}
      >
        Open the decision event in the timeline
      </UiLink>
    </div>
  );
}
