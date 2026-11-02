'use client';

import {
  EmptyState,
  Notice,
  ProvenanceBadge,
  RangeBar,
  ScoreRing,
  StatusBadge,
  cg,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { CheckmarkCircleRegular } from '@fluentui/react-icons';
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
  grid: {
    display: 'grid',
    gap: cg.space[4],
    gridTemplateColumns: 'minmax(0, 1fr)',
    alignItems: 'start',
    '@media (min-width: 900px)': { gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' },
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    minWidth: 0,
    padding: cg.space[4],
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surfaceSunken,
  },
  cardTitle: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
  },
  hero: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${cg.space[3]} ${cg.space[6]}`,
  },
  heroText: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    flex: '1 1 220px',
    minWidth: 0,
  },
  badges: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  text: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
    overflowWrap: 'anywhere',
  },
  strong: { color: cg.text, fontWeight: tokens.fontWeightSemibold },
  facts: {
    margin: 0,
    paddingLeft: cg.space[4],
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    fontSize: tokens.fontSizeBase300,
    color: cg.textSecondary,
  },
  label: { fontWeight: tokens.fontWeightSemibold, color: cg.text },
  block: { display: 'flex', flexDirection: 'column', gap: cg.space[1], minWidth: 0 },
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
      <div className={styles.card}>
        <h3 className={styles.cardTitle}>Case quality</h3>
        <PartState handle={quality} what="the case quality result" />
      </div>
    );
  }
  if (detail.source.kind !== 'ready') {
    return (
      <div className={styles.card}>
        <h3 className={styles.cardTitle}>Case quality</h3>
        <PartState handle={detail} what="the case record" />
      </div>
    );
  }
  const verdict = deriveVerdict({
    quality: quality.source.data,
    coaching: coaching.source.kind === 'ready' ? coaching.source.data : null,
    forks: forks.source.kind === 'ready' ? forks.source.data : null,
    detail: detail.source.data,
    metrics: metrics.source.kind === 'ready' ? metrics.source.data : null,
  });
  return (
    <div className={styles.card}>
      <h3 className={styles.cardTitle}>Case quality</h3>
      {verdict.placeholder ? (
        <Notice variant="warning" compact title="Nothing can be assessed yet">
          What was known is not enough to score any area, so there is no score to show.
        </Notice>
      ) : (
        <div className={styles.hero}>
          <ScoreRing
            value={verdict.score}
            low={verdict.low}
            high={verdict.high}
            label="Case quality"
            status={verdict.ring}
            statusLabel={verdict.bandLabel}
            caption="Estimated"
          />
          <div className={styles.heroText}>
            <div className={styles.badges}>
              <StatusBadge status={verdict.badge} label={verdict.bandLabel} />
              <ProvenanceBadge kind="estimated" />
            </div>
            <p className={styles.text}>
              <span className={styles.strong}>{verdict.headline}</span> {verdict.meaning}
            </p>
            <RangeBar
              value={verdict.score}
              low={verdict.low}
              high={verdict.high}
              label="Case quality"
              format={num}
              showScale
            />
          </div>
        </div>
      )}
      <ul className={styles.facts}>
        {verdict.facts.map((fact) => (
          <li key={fact}>{fact}</li>
        ))}
        {verdict.effort ? (
          <li>
            Avoidable support effort:{' '}
            <span className={styles.strong}>{verdict.effort.display}</span>
            {verdict.effort.rangeText ? `, plausible range ${verdict.effort.rangeText}` : ''} (
            {verdict.effort.confidenceLabel}).
          </li>
        ) : null}
      </ul>
      {verdict.coachingSummary ? (
        <div className={styles.block}>
          <span className={styles.label}>In the coach’s words</span>
          <ClampedText text={verdict.coachingSummary} lines={4} label="coaching summary" />
        </div>
      ) : (
        <PartState handle={coaching} what="the coaching summary" />
      )}
      <Notice variant="model-estimate" compact title="How certain is this?">
        {verdict.uncertaintyNote}
      </Notice>
    </div>
  );
}

function MissedMomentCard({ caseId }: { caseId: string }) {
  const styles = useStyles();
  const forks = useForksHandle(caseId);
  const moment = forks.source.kind === 'ready' ? deriveMissedMoment(forks.source.data) : null;
  const titles = useLinkTitles(caseId, moment?.knownLinks ?? []);
  return (
    <div className={styles.card}>
      <h3 className={styles.cardTitle}>The earliest important missed moment</h3>
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
            <SectionLink to="decisions" appearance="primary">
              See what went wrong
            </SectionLink>
          </div>
        </>
      ) : (
        <EmptyState
          compact
          icon={<CheckmarkCircleRegular />}
          title="No decision point stood out"
          description="The analysis found no moment where a clearly better-supported step was available. That is a good sign for this case, not an error."
        />
      )}
    </div>
  );
}

/**
 * The verdict: how good the case was (case quality with its range, an estimate), the result in words, and the earliest
 * important missed moment with what was done and what was already known. Each card reads and fails on its own: a role
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
      description="How the investigation went, as an estimate, and the first moment a better step was missed."
      badges={<ProvenanceBadge kind="estimated" />}
      method={notes}
    >
      <div className={styles.grid}>
        <QualityCard caseId={caseId} />
        <MissedMomentCard caseId={caseId} />
      </div>
    </SectionFrame>
  );
}
