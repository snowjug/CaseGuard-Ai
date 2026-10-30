'use client';

import type { DecisionFork } from '@caseguard/schemas';
import { FORK_CATEGORY_LABELS } from '@caseguard/schemas';
import {
  BadgeShell,
  Panel,
  ProvenanceBadge,
  StatusBadge,
  UiLink,
  cg,
  formatDateTimeUtc,
  formatProbability,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { StarRegular } from '@fluentui/react-icons';
import { caseHref, evidenceLinkHref } from '../../lib/deep-links';
import { LEVEL_LABELS, SEVERITY_BADGES } from '../reasoning/labels';
import { instantBefore } from '../reasoning/time';

const useStyles = makeStyles({
  badges: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  text: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
    overflowWrap: 'anywhere',
  },
  muted: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  links: { display: 'flex', flexWrap: 'wrap', gap: `${cg.space[1]} ${cg.space[4]}` },
  link: {
    color: cg.textLink,
    textDecorationLine: 'underline',
    textUnderlineOffset: '2px',
    minHeight: '24px',
    display: 'inline-flex',
    alignItems: 'center',
  },
});

export interface ForkHeaderProps {
  caseId: string;
  fork: DecisionFork;
}

/** The selected decision fork: why it was flagged, when it happened and how to see the moment in the other pages. */
export function ForkHeader({ caseId, fork }: ForkHeaderProps) {
  const styles = useStyles();
  const severity = SEVERITY_BADGES[fork.severity];
  return (
    <Panel
      title={fork.title}
      description={fork.summary}
      accent="fork"
      help="A decision fork is a moment where a better path was available. The summary says why this one was flagged. Everything on this page about the fork uses only what was known at its decision instant, except the clearly labelled hindsight panel."
    >
      <div className={styles.badges}>
        {fork.isEarliestMeaningful ? (
          <BadgeShell
            tone="fork"
            pattern="solid"
            icon={<StarRegular />}
            label="Earliest meaningful fork"
            size="medium"
          />
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
      <p className={styles.muted}>Decision at {formatDateTimeUtc(fork.timestamp)}</p>
      <div className={styles.links}>
        <UiLink
          className={styles.link}
          href={`${caseHref(caseId, 'hypotheses')}?asOf=${encodeURIComponent(instantBefore(fork.timestamp))}`}
        >
          See the hypotheses just before this decision
        </UiLink>
        <UiLink
          className={styles.link}
          href={evidenceLinkHref(caseId, { type: 'event', id: fork.eventId })}
        >
          Open the decision event in the timeline
        </UiLink>
      </div>
    </Panel>
  );
}
