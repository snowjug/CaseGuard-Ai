'use client';

import {
  Accordion,
  AccordionItem,
  EmptyState,
  LoadingSkeleton,
  Notice,
  ProvenanceBadge,
  RangeBar,
  ScoreRing,
  cg,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { CircleCheckIcon } from 'lucide-react';
import { EvidenceChips } from '../evidence/EvidenceChips';
import { useLinkTitles } from '../evidence/useProvenance';
import {
  useCoachingHandle,
  useDetailHandle,
  useForksHandle,
  useMetricsHandle,
  useQualityHandle,
  useRunHandle,
} from '../hooks';
import { methodNotes } from '../model/method';
import { deriveMissedMoment, deriveVerdict } from '../model/verdict';
import { ClampedText } from '../../quality/ClampedText';
import { formatInstant } from '../../reasoning/format';
import { formatNumber } from '../../../lib/format';
import { PartState, SectionFrame, SectionLink } from './shared';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[6], minWidth: 0 },
  hero: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${cg.space[4]} ${cg.space[6]}`,
  },
  heroText: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    flex: '1 1 220px',
    minWidth: 0,
  },
  reason: {
    margin: 0,
    fontSize: tokens.fontSizeBase500,
    lineHeight: tokens.lineHeightBase500,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.015em',
    color: cg.text,
    overflowWrap: 'anywhere',
  },
  text: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
    overflowWrap: 'anywhere',
  },
  strong: { color: cg.text, fontWeight: tokens.fontWeightSemibold },
  saved: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
  },
  facts: {
    margin: 0,
    paddingLeft: cg.space[4],
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    fontSize: tokens.fontSizeBase300,
    color: cg.textSecondary,
  },
  label: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '0.02em',
    color: cg.textMuted,
  },
  block: { display: 'flex', flexDirection: 'column', gap: cg.space[1], minWidth: 0 },
  detail: { display: 'flex', flexDirection: 'column', gap: cg.space[4] },
  moment: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    minWidth: 0,
    padding: cg.space[4],
    borderRadius: cg.radius.lg,
    backgroundColor: cg.surfaceSunken,
  },
  momentTitle: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.textMuted,
  },
  actions: { display: 'flex', flexWrap: 'wrap', gap: cg.space[2] },
});

const num = (value: number): string => formatNumber(value, { maximumFractionDigits: 0 });

function QualityCard({ caseId }: { caseId: string }) {
  const styles = useStyles();
  const quality = useQualityHandle(caseId);
  const coaching = useCoachingHandle(caseId);
  const metrics = useMetricsHandle(caseId);
  const forks = useForksHandle(caseId);
  const detail = useDetailHandle(caseId);
  if (quality.source.kind !== 'ready') {
    return (
      <PartState
        handle={quality}
        what="the case quality result"
        skeleton={<LoadingSkeleton variant="card" count={1} label="Loading the case quality" />}
      />
    );
  }
  if (detail.source.kind !== 'ready') {
    return <PartState handle={detail} what="the case record" />;
  }
  const verdict = deriveVerdict({
    quality: quality.source.data,
    coaching: coaching.source.kind === 'ready' ? coaching.source.data : null,
    forks: forks.source.kind === 'ready' ? forks.source.data : null,
    detail: detail.source.data,
    metrics: metrics.source.kind === 'ready' ? metrics.source.data : null,
  });
  if (verdict.placeholder) {
    return (
      <Notice variant="warning" compact title="Nothing can be assessed yet">
        What was known is not enough to score any area, so there is no score to show.
      </Notice>
    );
  }
  return (
    <div className={styles.stack}>
      <div className={styles.hero}>
        <ScoreRing
          value={verdict.score}
          low={verdict.low}
          high={verdict.high}
          label="Case quality"
          size={168}
          status={verdict.ring}
          statusLabel={verdict.bandLabel}
          caption="Estimated"
        />
        <div className={styles.heroText}>
          <p className={styles.reason}>{verdict.meaning}</p>
          <p className={styles.text}>{verdict.headline}</p>
          {verdict.effort ? (
            <p className={styles.saved}>
              Time that could have been saved:{' '}
              <span className={styles.strong}>{verdict.effort.display}</span>
              {verdict.effort.rangeText ? `, plausible range ${verdict.effort.rangeText}` : ''} (
              {verdict.effort.confidenceLabel}).
            </p>
          ) : null}
        </div>
      </div>
      <Accordion>
        <AccordionItem title="About this score" headingLevel={3} lazy={false}>
          <div className={styles.detail}>
            <RangeBar
              value={verdict.score}
              low={verdict.low}
              high={verdict.high}
              label="Case quality"
              format={num}
              showScale
            />
            <ul className={styles.facts}>
              {verdict.facts.map((fact) => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
            {verdict.coachingSummary ? (
              <div className={styles.block}>
                <span className={styles.label}>In the coach’s words</span>
                <ClampedText text={verdict.coachingSummary} lines={4} label="coaching summary" />
              </div>
            ) : (
              <PartState handle={coaching} what="the coaching summary" />
            )}
            <div className={styles.block}>
              <span className={styles.label}>How certain is this?</span>
              <p className={styles.text}>{verdict.uncertaintyNote}</p>
            </div>
          </div>
        </AccordionItem>
      </Accordion>
    </div>
  );
}

function MissedMomentCard({ caseId }: { caseId: string }) {
  const styles = useStyles();
  const forks = useForksHandle(caseId);
  const moment = forks.source.kind === 'ready' ? deriveMissedMoment(forks.source.data) : null;
  const titles = useLinkTitles(caseId, moment?.knownLinks ?? []);
  return (
    <div className={styles.moment}>
      <h3 className={styles.momentTitle}>Earliest missed moment</h3>
      {forks.source.kind !== 'ready' ? (
        <PartState handle={forks} what="the decision points" />
      ) : moment ? (
        <>
          <p className={styles.text}>
            <span className={styles.strong}>{moment.title}</span> · {formatInstant(moment.at)}
          </p>
          <div className={styles.block}>
            <span className={styles.label}>What was done</span>
            <p className={styles.text}>{moment.didLabel}</p>
          </div>
          <div className={styles.block}>
            <span className={styles.label}>What was already known</span>
            <p className={styles.text}>{moment.knownSummary}</p>
            <EvidenceChips links={moment.knownLinks} subject={moment.title} titles={titles} />
          </div>
          {moment.betterLabel ? (
            <div className={styles.block}>
              <span className={styles.label}>A better-supported step was available</span>
              <p className={styles.text}>{moment.betterLabel}</p>
            </div>
          ) : null}
          <div className={styles.actions}>
            <SectionLink to="decisions" appearance="subtle">
              See what went wrong
            </SectionLink>
          </div>
        </>
      ) : (
        <EmptyState
          compact
          icon={<CircleCheckIcon />}
          title="No decision point stood out"
          description="The analysis found no moment where a clearly better-supported step was available. That is a good sign for this case, not an error."
        />
      )}
    </div>
  );
}

/**
 * The verdict: how good the case was (case quality with its range, an estimate), the result in words, and the earliest
 * important missed moment with what was done and what was already known. Each part reads and fails on its own: a role
 * that cannot read case quality still sees the missed moment, and the other way round.
 */
export function VerdictSection({ caseId }: { caseId: string }) {
  const styles = useStyles();
  const quality = useQualityHandle(caseId);
  const run = useRunHandle(caseId);
  const detail = useDetailHandle(caseId);
  const notes = methodNotes('verdict', {
    run: run.source.kind === 'ready' ? run.source.data : null,
    quality: quality.source.kind === 'ready' ? quality.source.data : null,
    qualityDenied: quality.source.kind === 'denied',
    coaching: null,
    detail: detail.source.kind === 'ready' ? detail.source.data : null,
    path: null,
  });
  return (
    <SectionFrame
      id="verdict"
      title="Verdict"
      description="How the investigation went, as an estimate."
      badges={<ProvenanceBadge kind="estimated" />}
      method={notes}
    >
      <div className={styles.stack}>
        <QualityCard caseId={caseId} />
        <MissedMomentCard caseId={caseId} />
      </div>
    </SectionFrame>
  );
}
