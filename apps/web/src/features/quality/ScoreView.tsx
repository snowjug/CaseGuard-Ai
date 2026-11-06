'use client';

import type { QualityAssessment } from '@caseguard/schemas';
import {
  BentoGrid,
  BentoItem,
  BlurFade,
  Button,
  Card,
  EmptyState,
  HelpButton,
  ProvenanceBadge,
  ScoreRing,
  cg,
  formatNumber,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { HistoryIcon, HourglassIcon, TrendingUpIcon } from 'lucide-react';
import { useId } from 'react';
import { formatBoundary } from './case-hooks';
import { ClampedText } from './ClampedText';
import { DimensionList } from './DimensionList';
import { useLook } from './look';
import { bandOf, isPlaceholderScore } from './quality-model';
import { LoweredList, RaiseList } from './ScoreLists';

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[6],
    height: '100%',
    boxSizing: 'border-box',
    '@media (max-width: 639px)': { padding: cg.space[4] },
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: cg.space[2],
  },
  titleLine: { display: 'flex', alignItems: 'center', gap: cg.space[1] },
  eyebrow: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.tone.brand.fg,
  },
  // A ring above its words on a phone and in the narrow desktop column; side by side when the card is wide and alone.
  body: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: cg.space[6],
    textAlign: 'center',
    flex: '1 1 auto',
    justifyContent: 'center',
    '@media (min-width: 640px)': {
      flexDirection: 'row',
      alignItems: 'center',
      textAlign: 'start',
      justifyContent: 'flex-start',
    },
    '@media (min-width: 1024px)': {
      flexDirection: 'column',
      alignItems: 'center',
      textAlign: 'center',
      justifyContent: 'center',
    },
  },
  ring: { flexShrink: 0 },
  words: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'inherit',
    gap: cg.space[3],
    minWidth: 0,
    flex: '1 1 auto',
  },
  reason: {
    margin: 0,
    maxWidth: '34ch',
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightMedium,
    letterSpacing: '-0.01em',
    color: cg.text,
  },
  after: {
    display: 'flex',
    alignItems: 'center',
    gap: cg.space[3],
    boxSizing: 'border-box',
    maxWidth: '100%',
    paddingBlock: cg.space[2],
    paddingInline: cg.space[3],
    borderRadius: cg.radius.md,
    backgroundColor: cg.tone.brand.tint,
    border: `1px solid color-mix(in srgb, ${cg.tone.brand.border} 40%, transparent)`,
    textAlign: 'start',
  },
  afterIcon: {
    display: 'inline-flex',
    flexShrink: 0,
    color: cg.tone.brand.fg,
    fontSize: tokens.fontSizeBase500,
  },
  afterText: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  afterTitle: {
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.tone.brand.fg,
  },
  afterValue: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
    fontVariantNumeric: 'tabular-nums',
  },
  note: { textAlign: 'start', width: '100%' },
});

const num = (value: number, digits = 0): string =>
  formatNumber(value, { maximumFractionDigits: digits });

const HERO_HELP =
  'The Case Quality Index is a model estimate from 0 to 100 that helps focus a human review of the investigation. It is not a rating of a person. The range shows how certain the estimate is.';

function AfterImprovements({ assessment }: { assessment: QualityAssessment }) {
  const styles = useStyles();
  const look = useLook();
  const titleId = useId();
  const after = assessment.estimatedScoreAfterImprovements;
  const gain = after.score - assessment.compositeScore;
  return (
    <div className={styles.after} role="group" aria-labelledby={titleId}>
      <span aria-hidden="true" className={styles.afterIcon}>
        <TrendingUpIcon />
      </span>
      <div className={styles.afterText}>
        <p id={titleId} className={styles.afterTitle}>
          If every improvement were applied
        </p>
        <p className={styles.afterValue}>
          About <span className={look.strong}>{num(after.score)} out of 100</span> (estimated)
        </p>
        <p className={look.meta}>
          Range {num(after.low)} to {num(after.high)}
        </p>
      </div>
      <HelpButton
        label="About the estimate after improvements"
        title="If every improvement were applied"
      >
        <p>An estimate for planning, not a prediction.</p>
        <p>{after.method}</p>
        <p>
          That is {gain >= 0 ? 'up' : 'down'} {num(Math.abs(gain), 1)} points from the current
          estimate, with a range of {num(after.low)} to {num(after.high)}.
        </p>
      </HelpButton>
    </div>
  );
}

function ScoreHero({
  assessment,
  onWholeRecord,
}: {
  assessment: QualityAssessment;
  onWholeRecord: () => void;
}) {
  const styles = useStyles();
  const look = useLook();
  const headingId = useId();
  const band = bandOf(assessment.band);
  const placeholder = isPlaceholderScore(assessment);
  return (
    <Card hero glow padding="lg" role="group" aria-labelledby={headingId} className={styles.card}>
      <div className={styles.head}>
        <div className={styles.titleLine}>
          <h2 id={headingId} className={styles.eyebrow}>
            Case Quality Index
          </h2>
          <HelpButton label="About Case Quality Index" title="Case Quality Index">
            <p>{HERO_HELP}</p>
            <p>Scoring configuration {assessment.configVersion}.</p>
          </HelpButton>
        </div>
        <ProvenanceBadge kind="estimated" />
      </div>
      {placeholder ? (
        <EmptyState
          compact
          headingLevel={3}
          icon={<HourglassIcon />}
          title="Nothing can be assessed yet"
          description="What was known at this moment is not enough to score any area, so there is no score to show. Move the time cursor later, or clear it to see the whole record."
          action={
            <Button variant="secondary" icon={<HistoryIcon />} onClick={onWholeRecord}>
              Show the whole record
            </Button>
          }
        />
      ) : (
        <div className={styles.body}>
          <div className={styles.ring}>
            <ScoreRing
              value={assessment.compositeScore}
              low={assessment.compositeLow}
              high={assessment.compositeHigh}
              label="Case Quality Index"
              size={192}
              status={band.ring}
              statusLabel={band.label}
              caption="Estimated"
            />
          </div>
          <div className={styles.words}>
            <p className={styles.reason}>{band.meaning}</p>
            <p className={look.meta}>
              The plausible range is {num(assessment.compositeLow)} to{' '}
              {num(assessment.compositeHigh)} out of 100.
              {assessment.asOf
                ? ` Scored as of ${formatBoundary(assessment.asOf)}, using only what was known then.`
                : ''}
            </p>
            <AfterImprovements assessment={assessment} />
          </div>
        </div>
      )}
      <div className={styles.note}>
        <ClampedText
          text={assessment.uncertaintyNote}
          lines={2}
          label="note on how certain this is"
        />
      </div>
    </Card>
  );
}

export interface ScoreViewProps {
  assessment: QualityAssessment;
  caseId: string;
  /** Leaves an earlier view for the whole record (offered when nothing could be assessed at the moment chosen). */
  onWholeRecord: () => void;
}

/**
 * The result of the Score page, in the order a person reads it: the score with its band and reason, the six areas it is
 * built from, what lowered it and what would raise it. Everything else (effort, warnings, skills, coaching, comparing)
 * sits under tabs below.
 */
export function ScoreView({ assessment, caseId, onWholeRecord }: ScoreViewProps) {
  const look = useLook();
  return (
    <BentoGrid>
      <BentoItem span={12} spanLg={5}>
        <BlurFade index={1} className={look.fill}>
          <ScoreHero assessment={assessment} onWholeRecord={onWholeRecord} />
        </BlurFade>
      </BentoItem>
      <BentoItem span={12} spanLg={7}>
        <BlurFade index={2} className={look.fill}>
          <DimensionList assessment={assessment} caseId={caseId} />
        </BlurFade>
      </BentoItem>
      <BentoItem span={12} spanLg={6}>
        <BlurFade index={3} className={look.fill}>
          <LoweredList assessment={assessment} caseId={caseId} />
        </BlurFade>
      </BentoItem>
      <BentoItem span={12} spanLg={6}>
        <BlurFade index={4} className={look.fill}>
          <RaiseList assessment={assessment} caseId={caseId} />
        </BlurFade>
      </BentoItem>
    </BentoGrid>
  );
}
