'use client';

import type { QualityAssessment, QualityDimension } from '@caseguard/schemas';
import { Panel, RangeBar, StatusBadge } from '@caseguard/ui';
import { ClampedText } from './ClampedText';
import { EvidenceLinkList } from './EvidenceLinkList';
import { isLeftOut, weightText } from './quality-model';
import { useInsightStyles } from './styles';
import { formatNumber, formatProbability } from '../../lib/format';

const HELP =
  'The index is built from six dimensions, each scored from transparent sub-checks, weighted, then reduced by capped, evidence-linked penalties. Weights are the configured ones, re-balanced over the dimensions that can be assessed from what was known. Open a dimension to see its checks; a check marked "could not be decided" widens the range instead of guessing.';

function DimensionRow({ dimension, caseId }: { dimension: QualityDimension; caseId: string }) {
  const styles = useInsightStyles();
  const leftOut = isLeftOut(dimension);
  return (
    <li className={styles.item}>
      <div className={styles.itemHead}>
        <h3 className={styles.itemTitle}>{dimension.label}</h3>
        {leftOut ? (
          <StatusBadge status="missing" label="Not yet assessable" size="small" />
        ) : (
          <span className={styles.meta}>Weight {weightText(dimension.weight)}</span>
        )}
      </div>
      {leftOut ? (
        <p className={styles.text}>
          Left out of the composite: what was known at this time is not enough to assess it.
        </p>
      ) : (
        <>
          <p className={styles.text}>
            <span className={styles.strong}>
              {formatNumber(dimension.score, { maximumFractionDigits: 0 })} out of 100
            </span>{' '}
            after penalties (estimate). Before penalties:{' '}
            {formatNumber(dimension.rawScore, { maximumFractionDigits: 0 })}.
            {dimension.penaltyPoints > 0
              ? ` Penalties took ${formatNumber(dimension.penaltyPoints, { maximumFractionDigits: 0 })} points on this dimension's own scale.`
              : ''}
          </p>
          <RangeBar
            value={dimension.score}
            low={dimension.low}
            high={dimension.high}
            label={`${dimension.label} score`}
            format={(value) => formatNumber(value, { maximumFractionDigits: 0 })}
            tone="brand"
          />
        </>
      )}
      <ClampedText text={dimension.rationale} lines={2} label={`rationale of ${dimension.label}`} />
      {dimension.subChecks.length > 0 ? (
        <details className={styles.details}>
          <summary className={styles.summary}>
            {dimension.subChecks.length} {dimension.subChecks.length === 1 ? 'check' : 'checks'}{' '}
            behind this score
          </summary>
          <ul className={styles.list}>
            {dimension.subChecks.map((check) => (
              <li key={check.id} className={styles.detailsBody}>
                <div className={styles.itemHead}>
                  <p className={styles.itemTitle}>{check.label}</p>
                  {check.determinable ? (
                    <span className={styles.meta}>
                      {formatProbability(check.score, 0)} · weight{' '}
                      {formatNumber(check.weight, { maximumFractionDigits: 2 })}
                    </span>
                  ) : (
                    <StatusBadge status="uncertain" label="Could not be decided" size="small" />
                  )}
                </div>
                <p className={styles.text}>{check.note}</p>
                <EvidenceLinkList
                  caseId={caseId}
                  links={check.evidence}
                  label={`Evidence for ${check.label}`}
                />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}

export interface DimensionListProps {
  assessment: QualityAssessment;
  caseId: string;
}

/** The six dimensions with weight, score, range, rationale and the checks behind each. */
export function DimensionList({ assessment, caseId }: DimensionListProps) {
  const styles = useInsightStyles();
  return (
    <Panel
      title="Dimensions"
      description="Six areas of investigation quality, each scored from checks you can open."
      help={HELP}
    >
      <ul className={styles.list}>
        {assessment.dimensions.map((dimension) => (
          <DimensionRow key={dimension.key} dimension={dimension} caseId={caseId} />
        ))}
      </ul>
    </Panel>
  );
}
