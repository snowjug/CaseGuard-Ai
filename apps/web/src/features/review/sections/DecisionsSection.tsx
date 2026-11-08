'use client';

import { Button, EmptyState, ProvenanceBadge, StatusBadge, UiLink, cg } from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { ChevronDownIcon, CircleCheckIcon } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { evidenceLinkHref } from '../../../lib/deep-links';
import { ClampedText } from '../../quality/ClampedText';
import { formatInstant } from '../../reasoning/format';
import { EvidenceChips } from '../evidence/EvidenceChips';
import { useLinkTitles } from '../evidence/useProvenance';
import { useForksHandle, useRunHandle } from '../hooks';
import {
  DECISION_POINTS_SHOWN,
  deriveDecisionPoints,
  type DecisionPointModel,
} from '../model/decisions';
import { methodNotes } from '../model/method';
import { plural } from '../model/words';
import { PartState, SectionFrame } from './shared';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[4],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    minWidth: 0,
    padding: cg.space[6],
    borderRadius: cg.radius.lg,
    boxShadow: `inset 3px 0 0 ${cg.tone.fork.solid}`,
    backgroundColor: cg.surfaceSunken,
    '@media (max-width: 639px)': { padding: cg.space[4] },
  },
  head: { display: 'flex', flexDirection: 'column', gap: cg.space[1] },
  badges: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
    overflowWrap: 'anywhere',
  },
  meta: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  text: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
    overflowWrap: 'anywhere',
  },
  grid: {
    display: 'grid',
    gap: cg.space[3],
    gridTemplateColumns: 'minmax(0, 1fr)',
    '@media (min-width: 900px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
  },
  block: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    minWidth: 0,
    padding: cg.space[3],
    borderRadius: cg.radius.md,
    backgroundColor: cg.surface,
  },
  blockTitle: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
  },
  bullets: {
    margin: 0,
    paddingLeft: cg.space[4],
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    fontSize: tokens.fontSizeBase300,
    color: cg.textSecondary,
  },
  strong: { color: cg.text, fontWeight: tokens.fontWeightSemibold },
  estimate: { display: 'flex', flexDirection: 'column', gap: cg.space[1] },
  link: {
    color: cg.textLink,
    textDecorationLine: 'underline',
    textUnderlineOffset: '2px',
    fontSize: tokens.fontSizeBase300,
    minHeight: '24px',
    alignSelf: 'flex-start',
  },
  more: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[3] },
});

function DecisionCard({
  caseId,
  point,
  titles,
}: {
  caseId: string;
  point: DecisionPointModel;
  titles: ReadonlyMap<string, string>;
}) {
  const styles = useStyles();
  const headingId = useId();
  return (
    <li>
      <article className={styles.card} aria-labelledby={headingId}>
        <div className={styles.head}>
          <div className={styles.badges}>
            <StatusBadge status="uncertain" label={`Decision point ${point.number}`} size="small" />
            <StatusBadge status={point.impactBadge} label={point.impactLabel} size="small" />
            {point.isEarliest ? (
              <StatusBadge status="neutral" label="The earliest important one" size="small" />
            ) : null}
          </div>
          <h3 id={headingId} className={styles.title}>
            {point.title}
          </h3>
          <p className={styles.meta}>
            {formatInstant(point.at)} · {point.categoryLabel}
          </p>
        </div>
        <p className={styles.text}>{point.whatHappened}</p>
        <div className={styles.grid}>
          <div className={styles.block}>
            <h4 className={styles.blockTitle}>What was known then</h4>
            <p className={styles.text}>{point.known.summary}</p>
            <EvidenceChips
              links={point.known.links}
              subject={`${point.title} (what was known then)`}
              titles={titles}
            />
          </div>
          <div className={styles.block}>
            <h4 className={styles.blockTitle}>What was not yet known</h4>
            {point.notYetKnown.length > 0 ? (
              <ul className={styles.bullets}>
                {point.notYetKnown.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : (
              <p className={styles.text}>The analysis named nothing that was still missing.</p>
            )}
          </div>
          <div className={styles.block}>
            <h4 className={styles.blockTitle}>What was done</h4>
            <p className={styles.text}>
              <span className={styles.strong}>{point.did.label}</span>
            </p>
            <p className={styles.meta}>
              {[
                point.did.kindLabel,
                point.did.effortLabel,
                point.did.destructive ? 'Disruptive step' : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          <div className={styles.block}>
            <h4 className={styles.blockTitle}>A better-supported step</h4>
            {point.better ? (
              <>
                <p className={styles.text}>
                  <span className={styles.strong}>{point.better.label}</span>
                </p>
                <p className={styles.meta}>
                  {point.better.kindLabel} · {point.better.effortLabel}
                </p>
                <ClampedText text={point.better.rationale} lines={3} label="rationale" />
                <EvidenceChips
                  links={point.better.links}
                  subject={`${point.better.label} (what supports it)`}
                  titles={titles}
                />
              </>
            ) : (
              <p className={styles.text}>
                The analysis found no safe alternative that was clearly better at that moment.
              </p>
            )}
          </div>
        </div>
        <div className={styles.estimate}>
          <div className={styles.badges}>
            <ProvenanceBadge kind="estimated" />
            <span className={styles.meta}>{point.uncertainty.levelLabel}</span>
          </div>
          <p className={styles.text}>
            Time to useful evidence: {point.estimate.didTime} for the step taken
            {point.estimate.betterTime
              ? `, ${point.estimate.betterTime} for the better step`
              : ''}. {point.estimate.deltaSummary}
          </p>
          <p className={styles.meta}>{point.uncertainty.rationale}</p>
        </div>
        <UiLink
          className={styles.link}
          href={evidenceLinkHref(caseId, { type: 'fork', id: point.forkId })}
          aria-label={`Open in What if: decision point ${point.number}`}
        >
          Open in What if
        </UiLink>
      </article>
    </li>
  );
}

/**
 * What went wrong: the decision points, earliest first, a few at a time. Each says what was known then and what was not
 * yet known (so no hindsight leaks in), what was done, and the better-supported step that was available, with the
 * evidence for each as chips that open the evidence drawer.
 */
export function DecisionsSection({ caseId }: { caseId: string }) {
  const styles = useStyles();
  const forks = useForksHandle(caseId);
  const run = useRunHandle(caseId);
  const [expanded, setExpanded] = useState(false);
  const data = forks.source.kind === 'ready' ? forks.source.data : null;
  const points = useMemo(() => (data ? deriveDecisionPoints(data) : []), [data]);
  const shown = expanded ? points : points.slice(0, DECISION_POINTS_SHOWN);
  const titles = useLinkTitles(
    caseId,
    shown.flatMap((point) => [...point.known.links, ...(point.better?.links ?? [])]),
  );
  const listId = useId();
  const notes = methodNotes('decisions', {
    run: run.source.kind === 'ready' ? run.source.data : null,
    quality: null,
    coaching: null,
    detail: null,
    path: null,
  });
  const rest = points.length - shown.length;
  return (
    <SectionFrame
      id="decisions"
      title="What went wrong"
      description="The moments where a better-supported step was available, judged only from what was known then."
      badges={<ProvenanceBadge kind="estimated" />}
      method={notes}
      collapsible
    >
      {forks.source.kind !== 'ready' ? (
        <PartState handle={forks} what="the decision points" />
      ) : points.length === 0 ? (
        <EmptyState
          compact
          icon={<CircleCheckIcon />}
          title="No decision point stood out"
          description="The analysis found no moment where a clearly better-supported step was available. That is a good sign for this case, not an error."
        />
      ) : (
        <div className={styles.stack}>
          <p className={styles.text}>
            {plural(points.length, 'decision point')} found, earliest first.
            {rest > 0
              ? ` The first ${shown.length} are explained; the others are one click away.`
              : ''}
          </p>
          <ol id={listId} className={styles.list} aria-label="Decision points">
            {shown.map((point) => (
              <DecisionCard key={point.forkId} caseId={caseId} point={point} titles={titles} />
            ))}
          </ol>
          {points.length > DECISION_POINTS_SHOWN ? (
            <div className={styles.more}>
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={expanded}
                aria-controls={listId}
                icon={<ChevronDownIcon />}
                iconPosition="end"
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded
                  ? `Show only the first ${DECISION_POINTS_SHOWN}`
                  : `Show ${plural(rest, 'more decision point')}`}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </SectionFrame>
  );
}
