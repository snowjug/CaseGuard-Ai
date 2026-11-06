'use client';

import type { AnalyticsOverview } from '@caseguard/schemas';
import {
  Accordion,
  AccordionItem,
  Badge,
  BarChart,
  BlurFade,
  Card,
  DataTable,
  EmptyState,
  HelpButton,
  ProvenanceBadge,
  StatCard,
  cg,
  formatNumber,
  type DataTableColumn,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import {
  ChartColumnIcon,
  GaugeIcon,
  HourglassIcon,
  InfoIcon,
  LayersIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useId } from 'react';
import { formatPercent } from '../../lib/format';
import { useLook } from './look';
import {
  averageQuality,
  casesText,
  formatPeriod,
  isEveryMonthOneCase,
  isSmallSample,
  trendChange,
  waitingTimeSaved,
} from './portfolio-model';

const useStyles = makeStyles({
  // Three across on a tablet; stacked beside the chart on a desktop.
  figures: {
    display: 'grid',
    gap: cg.space[4],
    gridTemplateColumns: 'minmax(0, 1fr)',
    height: '100%',
    '@media (min-width: 640px)': { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' },
    '@media (min-width: 1024px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
    '@media (min-width: 1280px)': { gap: cg.space[6] },
  },
  figure: { height: '100%', boxSizing: 'border-box' },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[4],
    height: '100%',
    boxSizing: 'border-box',
  },
  head: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: cg.space[3],
  },
  titleLine: { display: 'flex', alignItems: 'center', gap: cg.space[1] },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.01em',
    color: cg.text,
  },
  footer: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: cg.space[1] },
  caveat: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${cg.space[1]} ${cg.space[2]}`,
    margin: 0,
  },
  // The numbers sit at the foot of the card, whatever height the card is stretched to beside the figures.
  numbers: { marginTop: 'auto' },
});

const whole = (value: number): string => formatNumber(value, { maximumFractionDigits: 0 });

/** The sample-size caveat: the one inline notice of the screen, because it changes how every figure is read. */
function SampleNote({ cohort }: { cohort: AnalyticsOverview['cohort'] }) {
  const styles = useStyles();
  const look = useLook();
  const small = isSmallSample(cohort);
  return (
    <div className={styles.footer}>
      <p className={look.meta}>
        {casesText(cohort.caseCount)} in this view, {whole(cohort.syntheticCaseCount)} of them demo
        data.
      </p>
      <Badge
        tone={small ? 'uncertain' : 'neutral'}
        icon={small ? <TriangleAlertIcon /> : <InfoIcon />}
        size="sm"
      >
        {small ? 'Small sample' : 'Sample size'}
      </Badge>
      <p className={look.meta}>{cohort.note}</p>
    </div>
  );
}

/** The three figures that answer "how is quality across my cases": how many, how good, how much time was left on the table. */
export function KeyFigures({ data }: { data: AnalyticsOverview }) {
  const styles = useStyles();
  const look = useLook();
  const { cohort } = data;
  const average = averageQuality(data.qualityTrend);
  const change = trendChange(data.qualityTrend);
  const saved = waitingTimeSaved(data.avoidableEffortPatterns);
  return (
    <div className={styles.figures}>
      <BlurFade index={1} className={styles.figure}>
        <StatCard
          className={styles.figure}
          headingLevel={2}
          label="Cases analysed"
          icon={<LayersIcon />}
          value={cohort.analyzedCaseCount}
          format={whole}
          help={
            <p>
              The cases these figures cover (the cohort). Only analysed cases contribute. With fewer
              than ten, every average and trend is illustrative only.
            </p>
          }
          footer={<SampleNote cohort={cohort} />}
        />
      </BlurFade>
      <BlurFade index={2} className={styles.figure}>
        <StatCard
          className={styles.figure}
          headingLevel={2}
          label="Average score"
          icon={<GaugeIcon />}
          value={average ? average.value : null}
          format={whole}
          unit="/ 100"
          {...(change
            ? {
                delta: {
                  text: `${formatNumber(Math.abs(change.points), { maximumFractionDigits: 1 })} points ${change.points >= 0 ? 'higher' : 'lower'} than ${formatPeriod(change.from)}`,
                  judgement:
                    change.points === 0
                      ? ('steady' as const)
                      : change.points > 0
                        ? ('improving' as const)
                        : ('worsening' as const),
                },
              }
            : {})}
          help={
            <p>
              The average Case Quality Index of the analysed cases, weighted by the cases in each
              month. It is an estimate that focuses a human review; it is not a rating of a person.
            </p>
          }
          footer={
            <span className={look.row}>
              <ProvenanceBadge kind="estimated" />
              {average ? (
                <span className={look.meta}>Across {casesText(average.caseCount)}</span>
              ) : null}
            </span>
          }
        />
      </BlurFade>
      <BlurFade index={3} className={styles.figure}>
        <StatCard
          className={styles.figure}
          headingLevel={2}
          label="Time that could have been saved"
          icon={<HourglassIcon />}
          value={saved ? saved.pct : null}
          format={(value) => formatPercent(value, 0)}
          {...(saved ? { unit: 'of waiting time' } : {})}
          help={
            <p>
              The average share of the waiting time to diagnosis that a better step would have
              avoided, over the cases that have an estimate. It compares the real path with a
              simulated one, so it is an estimate and never a measurement.
            </p>
          }
          footer={
            <span className={styles.footer}>
              <span className={look.row}>
                <ProvenanceBadge kind="estimated" />
                <ProvenanceBadge kind="simulated" />
              </span>
              <span className={look.meta}>
                {saved
                  ? `Based on ${casesText(saved.caseCount)} with an estimate`
                  : 'Needs an analysed case with a key decision and a valid simulated path.'}
              </span>
            </span>
          }
        />
      </BlurFade>
    </div>
  );
}

type TrendRow = AnalyticsOverview['qualityTrend'][number];

const TREND_COLUMNS: readonly DataTableColumn<TrendRow>[] = [
  {
    id: 'period',
    header: 'Month opened',
    rowHeader: true,
    cell: (row) => formatPeriod(row.period),
    sortValue: (row) => row.period,
  },
  {
    id: 'cases',
    header: 'Cases',
    align: 'end',
    cell: (row) => formatNumber(row.caseCount, { maximumFractionDigits: 0 }),
    sortValue: (row) => row.caseCount,
  },
  {
    id: 'quality',
    header: 'Average score (estimate)',
    align: 'end',
    cell: (row) => formatNumber(row.avgQuality, { maximumFractionDigits: 1 }),
    sortValue: (row) => row.avgQuality,
  },
  {
    id: 'integrity',
    header: 'Average evidence integrity (estimate)',
    align: 'end',
    cell: (row) => formatNumber(row.avgEvidenceIntegrity, { maximumFractionDigits: 1 }),
    sortValue: (row) => row.avgEvidenceIntegrity,
  },
];

/** Quality over time: the key result of the page, with its numbers one click away. */
export function TrendCard({ trend }: { trend: AnalyticsOverview['qualityTrend'] }) {
  const styles = useStyles();
  const look = useLook();
  const headingId = useId();
  const plotted = trend.filter((row) => row.avgQuality !== null);
  return (
    <Card role="group" aria-labelledby={headingId} glow padding="md" className={styles.card}>
      <div className={styles.head}>
        <div className={look.tight}>
          <div className={styles.titleLine}>
            <h2 id={headingId} className={styles.title}>
              Quality over time
            </h2>
            <HelpButton label="About Quality over time" title="Quality over time">
              Each bar averages the Case Quality Index of the analysed cases opened in that month.
              The index is an estimate that focuses a human review; it is not a rating of a person.
              With only a few cases in a month, a bar is that case&rsquo;s own score rather than a
              trend.
            </HelpButton>
          </div>
          <p className={look.text}>Average score of the cases opened in each month.</p>
        </div>
        <ProvenanceBadge kind="estimated" />
      </div>
      {trend.length === 0 ? (
        <EmptyState
          compact
          headingLevel={3}
          icon={<ChartColumnIcon />}
          title="No quality scores yet"
          description="Scores appear here once cases have been analysed."
        />
      ) : (
        <>
          {isEveryMonthOneCase(trend) ? (
            <p className={styles.caveat}>
              <Badge tone="uncertain" icon={<TriangleAlertIcon />} size="sm">
                Individual cases, not a trend
              </Badge>
              <span className={look.meta}>
                Every month holds a single case, so each bar is that case&rsquo;s own estimate.
              </span>
            </p>
          ) : null}
          <BarChart
            title="Average score by month opened (estimates)"
            orientation="vertical"
            max={100}
            height={340}
            valueLabel="Average score (estimate)"
            valueFormat={(value) => formatNumber(value, { maximumFractionDigits: 1 })}
            data={plotted.map((row) => ({
              key: row.period,
              label: formatPeriod(row.period),
              value: row.avgQuality ?? 0,
              note: casesText(row.caseCount),
            }))}
          />
          <Accordion className={styles.numbers}>
            <AccordionItem
              title="Show the numbers"
              subtitle="Cases and averages for each month opened"
            >
              <DataTable
                caption="Quality by month opened"
                columns={TREND_COLUMNS}
                rows={trend}
                getRowId={(row) => row.period}
                dense
              />
            </AccordionItem>
          </Accordion>
        </>
      )}
    </Card>
  );
}
