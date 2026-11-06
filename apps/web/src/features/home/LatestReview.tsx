'use client';

import type { CaseSummary, CaseWarning, CommandCenter, MetricCard } from '@caseguard/schemas';
import {
  Badge,
  ButtonLink,
  Card,
  ProvenanceBadge,
  ScoreRing,
  StatusBadge,
  RelativeTime,
  cg,
  formatProbability,
  type ScoreStatus,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { ArrowRightIcon, LoaderIcon } from 'lucide-react';
import { CaseSelect } from '../../components/common/CaseSelect';
import { useSession } from '../../lib/auth/session';
import { caseHref } from '../../lib/deep-links';
import { ANALYSIS_STATE_BADGES, SEVERITY_LABELS } from '../../lib/labels';

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[6],
    height: '100%',
    boxSizing: 'border-box',
  },
  head: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: cg.space[3],
  },
  caseSelect: { width: 'min(100%, 280px)' },
  eyebrow: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.tone.brand.fg,
  },
  body: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${cg.space[6]} ${cg.space[8]}`,
  },
  ring: { flexShrink: 0 },
  copy: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    flex: '1 1 260px',
    minWidth: 0,
  },
  refLine: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  reference: {
    fontFamily: cg.font.mono,
    fontSize: tokens.fontSizeBase200,
    color: cg.textSecondary,
  },
  title: {
    margin: 0,
    color: cg.text,
    fontSize: tokens.fontSizeBase500,
    lineHeight: tokens.lineHeightBase500,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.015em',
    overflowWrap: 'anywhere',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  reason: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
  },
  meta: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  actions: { display: 'flex', flexWrap: 'wrap', gap: cg.space[2], marginTop: cg.space[2] },
});

/** The words of the quality bands, the same ones the Review and the Score page use for this score. */
const BAND: Record<MetricCard['status'], { status: ScoreStatus; label: string }> = {
  good: { status: 'good', label: 'Strong' },
  watch: { status: 'watch', label: 'Adequate' },
  poor: { status: 'poor', label: 'Poor' },
  unknown: { status: 'unknown', label: 'Not enough data' },
};

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

/** One line that says why the score is what it is: the top issue, else the likeliest cause, else that all is well. */
export function reasonFor(
  warnings: readonly CaseWarning[],
  hypothesis: CommandCenter['leadingHypothesis'],
  score: MetricCard['status'],
): string {
  const top = [...warnings].sort((a, b) => a.rank - b.rank)[0];
  if (top) return `${plural(warnings.length, 'issue')} to fix. The most important: ${top.title}`;
  const cause = hypothesis
    ? `Most likely cause of the problem: ${hypothesis.name} (${formatProbability(hypothesis.confidence)}, estimated).`
    : 'No open issues found.';
  return score === 'poor' || score === 'watch'
    ? `${cause} The review shows what went wrong.`
    : cause;
}

export interface LatestReviewProps {
  activeCase: CaseSummary;
  /** The Case Quality Index metric, for its range and band. */
  quality: MetricCard | undefined;
  warnings: readonly CaseWarning[];
  hypothesis: CommandCenter['leadingHypothesis'];
  selectedId: string | null;
  onChooseCase: (caseId: string) => void;
}

/** The hero of Home: the latest review at a glance, a big score, the reason in one line, and the way into the review. */
export function LatestReview({
  activeCase,
  quality,
  warnings,
  hypothesis,
  selectedId,
  onChooseCase,
}: LatestReviewProps) {
  const styles = useStyles();
  const { can } = useSession();
  // "Add a case" in the page header is the primary action for people who can add one; for everyone else it is the way in.
  const way = can('case:ingest') ? 'secondary' : 'primary';
  const analysed = activeCase.analysisState === 'analyzed';
  const running = activeCase.analysisState === 'running' || activeCase.analysisState === 'queued';
  const analysis = ANALYSIS_STATE_BADGES[activeCase.analysisState];
  const band = BAND[quality?.status ?? 'unknown'];
  return (
    <Card
      as="section"
      hero
      glow
      padding="lg"
      className={styles.card}
      aria-labelledby="home-latest-review"
    >
      <div className={styles.head}>
        <h2 id="home-latest-review" className={styles.eyebrow}>
          Latest review
        </h2>
        <CaseSelect
          ariaLabel="Case"
          className={styles.caseSelect}
          value={selectedId}
          onChange={onChooseCase}
        />
      </div>
      <div className={styles.body}>
        <div className={styles.ring}>
          <ScoreRing
            label="Case quality"
            size={176}
            value={analysed ? activeCase.qualityIndex : null}
            low={quality?.range?.low ?? null}
            high={quality?.range?.high ?? null}
            status={band.status}
            statusLabel={analysed ? band.label : analysis.label}
            caption={analysed && quality?.estimated ? 'Estimated' : undefined}
          />
        </div>
        <div className={styles.copy}>
          <div className={styles.refLine}>
            <span className={styles.reference}>{activeCase.reference}</span>
            <StatusBadge status={analysis.status} label={analysis.label} size="small" />
            <Badge tone="neutral" size="sm">
              {SEVERITY_LABELS[activeCase.severity]}
            </Badge>
            {activeCase.synthetic ? <ProvenanceBadge kind="synthetic" /> : null}
          </div>
          <p className={styles.title}>{activeCase.title}</p>
          <p className={styles.reason}>
            {analysed
              ? reasonFor(warnings, hypothesis, quality?.status ?? 'unknown')
              : running
                ? 'The review is running. The score appears when it finishes.'
                : activeCase.analysisState === 'failed'
                  ? 'The review did not finish. Open the case to run it again.'
                  : 'This case has not been reviewed yet. Open it to run the review.'}
          </p>
          <p className={styles.meta}>
            {analysed && activeCase.analyzedAt ? (
              <>
                Reviewed <RelativeTime value={activeCase.analyzedAt} />
              </>
            ) : (
              <>
                Opened <RelativeTime value={activeCase.openedAt} />
              </>
            )}
          </p>
          <div className={styles.actions}>
            {analysed ? (
              <ButtonLink
                href={caseHref(activeCase.id, 'review')}
                variant={way}
                icon={<ArrowRightIcon />}
                iconPosition="end"
              >
                Open review
              </ButtonLink>
            ) : (
              <ButtonLink
                href={caseHref(activeCase.id)}
                variant={way}
                icon={running ? <LoaderIcon /> : <ArrowRightIcon />}
                iconPosition="end"
              >
                Open case
              </ButtonLink>
            )}
            {analysed && hypothesis ? (
              <ButtonLink
                href={`${caseHref(hypothesis.caseId, 'hypotheses')}?sel=${encodeURIComponent(hypothesis.hypothesisId)}`}
                variant="ghost"
              >
                Compare possible causes
              </ButtonLink>
            ) : null}
          </div>
        </div>
      </div>
    </Card>
  );
}
