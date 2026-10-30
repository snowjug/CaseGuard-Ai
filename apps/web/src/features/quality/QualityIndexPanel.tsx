'use client';

import {
  PENALTY_LABELS,
  QUALITY_DIMENSION_LABELS,
  type QualityAssessment,
} from '@caseguard/schemas';
import {
  EmptyState,
  Notice,
  Panel,
  ProvenanceBadge,
  RangeBar,
  ScoreRing,
  StatusBadge,
  UiLink,
  cg,
} from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';
import { CheckmarkCircleRegular, ShieldCheckmarkRegular } from '@fluentui/react-icons';
import { evidenceLinkHref } from '../../lib/deep-links';
import { formatNumber } from '../../lib/format';
import { PRIORITY_BADGES } from '../../lib/labels';
import { formatBoundary } from './case-hooks';
import { ClampedText } from './ClampedText';
import { DimensionList } from './DimensionList';
import { EvidenceLinkList } from './EvidenceLinkList';
import { BAND_META, isPlaceholderScore } from './quality-model';
import { useInsightStyles } from './styles';

const useStyles = makeStyles({
  hero: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${cg.space[4]} ${cg.space[6]}`,
  },
  heroText: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    flex: '1 1 240px',
    minWidth: 0,
  },
});

const num = (value: number, digits = 0): string =>
  formatNumber(value, { maximumFractionDigits: digits });

function Hero({ assessment }: { assessment: QualityAssessment }) {
  const styles = useStyles();
  const text = useInsightStyles();
  const band = BAND_META[assessment.band];
  const placeholder = isPlaceholderScore(assessment);
  return (
    <Panel
      title="Case Quality Index"
      description={
        assessment.asOf
          ? `Scored as of ${formatBoundary(assessment.asOf)}, using only what was known then.`
          : 'The composite of six dimensions, minus capped penalties.'
      }
      help="The Case Quality Index is a model estimate (0 to 100) that focuses a human review on the investigation. It is not a rating of a person. The range shows how certain the estimate is."
      actions={<ProvenanceBadge kind="estimated" />}
    >
      {placeholder ? (
        <Notice variant="warning" compact title="Nothing can be assessed yet">
          What was known at this moment is not enough to score any dimension, so there is no score
          to show. Move the time cursor later, or clear it to see the whole record.
        </Notice>
      ) : (
        <div className={styles.hero}>
          <ScoreRing
            value={assessment.compositeScore}
            low={assessment.compositeLow}
            high={assessment.compositeHigh}
            label="Case Quality Index"
            status={band.ring}
            caption="Estimated"
          />
          <div className={styles.heroText}>
            <div className={text.itemHead}>
              <StatusBadge status={band.badge} label={band.label} />
              <span className={text.meta}>Configuration {assessment.configVersion}</span>
            </div>
            <p className={text.text}>
              <span className={text.strong}>{num(assessment.compositeScore)} out of 100</span>, with
              a plausible range of {num(assessment.compositeLow)} to {num(assessment.compositeHigh)}
              .
            </p>
            <RangeBar
              value={assessment.compositeScore}
              low={assessment.compositeLow}
              high={assessment.compositeHigh}
              label="Case Quality Index"
              format={(value) => num(value)}
              showScale
            />
          </div>
        </div>
      )}
      <Notice variant="model-estimate" compact title="How certain is this?">
        {assessment.uncertaintyNote}
      </Notice>
    </Panel>
  );
}

function AfterImprovements({ assessment }: { assessment: QualityAssessment }) {
  const text = useInsightStyles();
  const after = assessment.estimatedScoreAfterImprovements;
  const gain = after.score - assessment.compositeScore;
  return (
    <Panel
      title="If every improvement were applied"
      description="An estimate for planning, not a prediction."
      help="Assumes each listed improvement is carried out: the penalty it addresses is removed and the check it targets reaches full marks, then a share of that gain is assumed to materialise. The range runs from half of that gain to the full gain."
      actions={<ProvenanceBadge kind="estimated" />}
    >
      <p className={text.tileValue}>
        {num(after.score)}
        <span className={text.meta}> out of 100 (estimated)</span>
      </p>
      <RangeBar
        value={after.score}
        low={after.low}
        high={after.high}
        label="Estimated score after improvements"
        format={(value) => num(value)}
      />
      <p className={text.text}>
        That is {gain >= 0 ? 'up' : 'down'} {num(Math.abs(gain), 1)} points from the current
        estimate, with a range of {num(after.low)} to {num(after.high)}.
      </p>
      <ClampedText text={after.method} lines={3} label="method of the estimate" />
    </Panel>
  );
}

function Penalties({ assessment, caseId }: { assessment: QualityAssessment; caseId: string }) {
  const text = useInsightStyles();
  return (
    <Panel
      title="Applied penalties"
      description="Each penalty names the evidence it rests on."
      help="Penalties are rule-based and linked to evidence. They are capped so that one failure cannot zero a case. Points here are on the composite scale (what is taken off the 0 to 100 index); each dimension shows the same deduction on its own scale."
    >
      {assessment.penalties.length === 0 ? (
        <EmptyState
          compact
          headingLevel={3}
          icon={<CheckmarkCircleRegular />}
          title="No penalty applied"
          description="Nothing in what was known matched a penalty rule."
        />
      ) : (
        <>
          <p className={text.text}>
            {assessment.penalties.length}{' '}
            {assessment.penalties.length === 1 ? 'penalty' : 'penalties'},{' '}
            {num(assessment.totalPenaltyPoints, 1)} points in total
            {assessment.penaltyCapApplied
              ? '. A cap applies, so less than this total was taken off the index.'
              : '.'}
          </p>
          <ul className={text.list}>
            {assessment.penalties.map((penalty) => (
              <li key={penalty.id} className={text.item}>
                <div className={text.itemHead}>
                  <h3 className={text.itemTitle}>{PENALTY_LABELS[penalty.key]}</h3>
                  <StatusBadge
                    status="unsupported"
                    label={`−${num(penalty.points, 1)} points`}
                    size="small"
                  />
                  {penalty.dimension ? (
                    <span className={text.meta}>{QUALITY_DIMENSION_LABELS[penalty.dimension]}</span>
                  ) : null}
                </div>
                <ClampedText
                  text={penalty.rationale}
                  lines={3}
                  label={`explanation of ${penalty.label}`}
                />
                <EvidenceLinkList
                  caseId={caseId}
                  links={penalty.evidence}
                  label={`Evidence for ${penalty.label}`}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

function Improvements({ assessment, caseId }: { assessment: QualityAssessment; caseId: string }) {
  const text = useInsightStyles();
  return (
    <Panel
      title="Recommended improvements"
      description="The changes that would add the most, most important first."
      help="Improvements are constructive suggestions linked to the penalty or decision fork they address. The expected gain is an estimate of the points the index could rise by."
    >
      {assessment.improvements.length === 0 ? (
        <EmptyState
          compact
          headingLevel={3}
          icon={<ShieldCheckmarkRegular />}
          title="No improvement to suggest"
          description="Nothing in what was known calls for a change."
        />
      ) : (
        <ul className={text.list}>
          {assessment.improvements.map((item) => {
            const priority = PRIORITY_BADGES[item.priority];
            return (
              <li key={item.id} className={text.item}>
                <div className={text.itemHead}>
                  <StatusBadge status={priority.status} label={priority.label} size="small" />
                  <h3 className={text.itemTitle}>{item.title}</h3>
                </div>
                <ClampedText
                  text={item.description}
                  lines={3}
                  label={`description of ${item.title}`}
                />
                <p className={text.meta}>
                  Could add about {num(item.expectedScoreGain, 1)} points (estimated)
                </p>
                {item.linkedForkId ? (
                  <UiLink
                    href={evidenceLinkHref(caseId, { type: 'fork', id: item.linkedForkId })}
                    className={text.link}
                  >
                    Open the decision fork behind this
                  </UiLink>
                ) : null}
                <EvidenceLinkList
                  caseId={caseId}
                  links={item.evidence}
                  label={`Evidence for ${item.title}`}
                />
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

export interface QualityIndexViewProps {
  assessment: QualityAssessment;
  caseId: string;
}

/** The whole "Quality index" tab: the score, the estimate after improvements, the dimensions, the penalties and the advice. */
export function QualityIndexView({ assessment, caseId }: QualityIndexViewProps) {
  const text = useInsightStyles();
  const placeholder = isPlaceholderScore(assessment);
  return (
    <div className={text.page}>
      <div className={text.band}>
        <Hero assessment={assessment} />
        {placeholder ? null : <AfterImprovements assessment={assessment} />}
      </div>
      <DimensionList assessment={assessment} caseId={caseId} />
      <div className={text.band}>
        <Penalties assessment={assessment} caseId={caseId} />
        <Improvements assessment={assessment} caseId={caseId} />
      </div>
    </div>
  );
}
