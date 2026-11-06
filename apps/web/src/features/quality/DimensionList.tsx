'use client';

import type { QualityAssessment, QualityDimension } from '@caseguard/schemas';
import {
  Accordion,
  AccordionItem,
  Panel,
  StatusBadge,
  Tooltip,
  VisuallyHidden,
  cg,
  formatNumber,
  formatProbability,
  useMotionEnabled,
} from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import type { CSSProperties } from 'react';
import { ClampedText } from './ClampedText';
import { EvidenceLinkList } from './EvidenceLinkList';
import { useLook } from './look';
import { DIMENSION_COPY, isLeftOut, weightText } from './quality-model';

const HELP =
  'The score is built from six areas. Each is scored from checks you can open, weighted, then reduced by capped, evidence-linked penalties. Weights are the configured ones, re-balanced over the areas that can be assessed from what was known. A check marked "could not be decided" widens the range instead of guessing.';

const useStyles = makeStyles({
  name: { color: cg.text, fontWeight: tokens.fontWeightSemibold, overflowWrap: 'anywhere' },
  caption: {
    display: 'block',
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    color: cg.textSecondary,
    fontVariantNumeric: 'tabular-nums',
  },
  // The meter is one rounded track: the plausible range as a soft band, the score as the filled part.
  meter: {
    display: 'block',
    position: 'relative',
    width: '100%',
    height: '8px',
    marginBlock: cg.space[1],
    overflow: 'hidden',
    borderRadius: cg.radius.pill,
    backgroundColor: cg.surfaceSunken,
  },
  range: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    borderRadius: cg.radius.pill,
    backgroundColor: `color-mix(in srgb, ${cg.tone.brand.solid} 32%, transparent)`,
  },
  fill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    borderRadius: cg.radius.pill,
    backgroundImage: cg.gradientAccent,
  },
  // Draws once, on arrival; the global reduced-motion rule and `useMotionEnabled` both switch it off.
  fillIn: {
    animationName: { from: { width: '0%' } },
    animationDuration: cg.motion.slow,
    animationTimingFunction: cg.motion.easing,
    animationFillMode: 'both',
    animationDelay: 'calc(var(--cg-row, 0) * 40ms)',
  },
  score: { display: 'inline-flex', alignItems: 'baseline', gap: cg.space[1] },
  scoreValue: {
    color: cg.text,
    fontSize: tokens.fontSizeBase500,
    lineHeight: '1',
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.02em',
    fontVariantNumeric: 'tabular-nums',
  },
  scoreOf: { color: cg.textMuted, fontSize: tokens.fontSizeBase200 },
  details: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    paddingBottom: cg.space[2],
  },
  checkList: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    margin: 0,
    padding: 0,
    listStyleType: 'none',
  },
  check: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    minWidth: 0,
    paddingInlineStart: cg.space[3],
    borderLeft: `2px solid ${cg.borderSubtle}`,
  },
});

function Meter({ dimension, index }: { dimension: QualityDimension; index: number }) {
  const styles = useStyles();
  const animate = useMotionEnabled();
  const clamp = (value: number): number => Math.min(100, Math.max(0, value));
  const style = { '--cg-row': index } as CSSProperties;
  return (
    <span aria-hidden="true" className={styles.meter} style={style}>
      <span
        className={styles.range}
        style={{
          left: `${clamp(dimension.low)}%`,
          width: `${Math.max(clamp(dimension.high) - clamp(dimension.low), 1)}%`,
        }}
      />
      <span
        className={mergeClasses(styles.fill, animate && styles.fillIn)}
        style={{ width: `${clamp(dimension.score)}%` }}
      />
    </span>
  );
}

function DimensionDetails({ dimension, caseId }: { dimension: QualityDimension; caseId: string }) {
  const styles = useStyles();
  const look = useLook();
  const copy = DIMENSION_COPY[dimension.key];
  const whole = (value: number): string => formatNumber(value, { maximumFractionDigits: 0 });
  return (
    <div className={styles.details}>
      <p className={look.meta}>
        <span className={look.strong}>{dimension.label}:</span> {copy.definition}
      </p>
      {isLeftOut(dimension) ? null : (
        <p className={look.text}>
          Before penalties this area scored {whole(dimension.rawScore)} out of 100.
          {dimension.penaltyPoints > 0
            ? ` Penalties took off ${whole(dimension.penaltyPoints)} points on its own scale.`
            : ' No penalty applied to it.'}
        </p>
      )}
      <ClampedText text={dimension.rationale} lines={2} label={`rationale of ${copy.name}`} />
      {dimension.subChecks.length > 0 ? (
        <div className={look.tight}>
          <p className={look.title}>
            {dimension.subChecks.length} {dimension.subChecks.length === 1 ? 'check' : 'checks'}{' '}
            behind this score
          </p>
          <ul className={styles.checkList}>
            {dimension.subChecks.map((check) => (
              <li key={check.id} className={styles.check}>
                <div className={look.row}>
                  <p className={look.title}>{check.label}</p>
                  {check.determinable ? (
                    <span className={look.meta}>
                      {formatProbability(check.score, 0)} · weight{' '}
                      {formatNumber(check.weight, { maximumFractionDigits: 2 })}
                    </span>
                  ) : (
                    <StatusBadge status="uncertain" label="Could not be decided" size="small" />
                  )}
                </div>
                <p className={look.text}>{check.note}</p>
                <EvidenceLinkList
                  caseId={caseId}
                  links={check.evidence}
                  label={`Evidence for ${check.label}`}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function DimensionRow({
  dimension,
  caseId,
  index,
}: {
  dimension: QualityDimension;
  caseId: string;
  index: number;
}) {
  const styles = useStyles();
  const copy = DIMENSION_COPY[dimension.key];
  const leftOut = isLeftOut(dimension);
  const whole = (value: number): string => formatNumber(value, { maximumFractionDigits: 0 });
  return (
    <AccordionItem
      headingLevel={3}
      title={
        <Tooltip content={`${dimension.label}: ${copy.definition}`} side="bottom">
          <span className={styles.name}>{copy.name}</span>
        </Tooltip>
      }
      subtitle={
        leftOut ? (
          <span className={styles.caption}>
            Left out of the score: what was known at this time is not enough to assess it.
          </span>
        ) : (
          <>
            <Meter dimension={dimension} index={index} />
            <span className={styles.caption}>
              Counts for {weightText(dimension.weight)} of the score · plausible range{' '}
              {whole(dimension.low)} to {whole(dimension.high)}
            </span>
          </>
        )
      }
      badge={
        leftOut ? (
          <StatusBadge status="missing" label="Not yet assessable" size="small" />
        ) : (
          <span className={styles.score}>
            <span aria-hidden="true" className={styles.scoreValue}>
              {whole(dimension.score)}
            </span>
            <span aria-hidden="true" className={styles.scoreOf}>
              /100
            </span>
            <VisuallyHidden>{whole(dimension.score)} out of 100</VisuallyHidden>
          </span>
        )
      }
    >
      <DimensionDetails dimension={dimension} caseId={caseId} />
    </AccordionItem>
  );
}

export interface DimensionListProps {
  assessment: QualityAssessment;
  caseId: string;
}

/**
 * The six areas of the score as meters: a plain name (the technical one in a tooltip), the score with its plausible
 * range and how much it counts for. Each row opens to the checks behind it and the evidence they rest on.
 */
export function DimensionList({ assessment, caseId }: DimensionListProps) {
  const look = useLook();
  return (
    <Panel
      title="How the score was built"
      description="Six areas, each scored from checks you can open."
      help={HELP}
      className={look.fill}
    >
      <Accordion>
        {assessment.dimensions.map((dimension, index) => (
          <DimensionRow key={dimension.key} dimension={dimension} caseId={caseId} index={index} />
        ))}
      </Accordion>
    </Panel>
  );
}
