'use client';

import type { AnalysisRun, CaseDetail } from '@caseguard/schemas';
import {
  Accordion,
  AccordionItem,
  BlurFade,
  ButtonLink,
  Card,
  EmptyState,
  PageHeader,
  Panel,
  ProvenanceBadge,
  cg,
} from '@caseguard/ui';
import { makeStyles, mergeClasses } from '@fluentui/react-components';
import { ClipboardCheckIcon, FileSearchIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  AsOfLimited,
  asOfCall,
  asOfFresh,
  isRateLimited,
  useAsOfCursor,
} from '../../components/case/as-of';
import { CaseNotFoundState } from '../../components/case/CaseNotFoundState';
import { caseTimeRange, useCaseDetail, useKnownAt } from '../../components/case/case-hooks';
import { isNotAnalysedError } from '../../components/case/NotAnalysedState';
import { JobProgress } from '../../components/common/JobProgress';
import { QueryBoundary } from '../../components/common/QueryBoundary';
import { QueryErrorState } from '../../components/common/QueryErrorState';
import { keepWithinBoundary } from '../../lib/api/boundary-placeholder';
import { useApiQuery } from '../../lib/api/hooks';
import { useAuth } from '../../lib/auth/context';
import { caseHref } from '../../lib/deep-links';
import { ReviewRunDetails, RunReviewButton, runSubtitle, useReviewRun } from './AnalysisPanel';
import { CaseDetailsSkeleton } from './CaseDetailsSkeleton';
import {
  KeyFacts,
  KnownLaterBadge,
  ReceivedDetails,
  ReceivedFlags,
  ResolutionDetails,
  receivedSubtitle,
} from './CaseFacts';
import { CaseLinks } from './CaseLinks';
import { CaseMenu } from './CaseMenu';
import { TwinPanel, TwinSkeleton } from './TwinPanel';
import { WhatWasKnown } from './WhatWasKnown';

const useStyles = makeStyles({
  page: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  busy: { opacity: 0.72 },
  columns: {
    display: 'grid',
    gap: cg.space[4],
    gridTemplateColumns: 'minmax(0, 1fr)',
    alignItems: 'start',
    '@media (min-width: 1100px)': {
      gridTemplateColumns: 'minmax(0, 7fr) minmax(0, 5fr)',
      gridTemplateRows: 'auto 1fr',
      gridTemplateAreas: '"structure known" "structure more"',
    },
  },
  known: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    minWidth: 0,
    '@media (min-width: 1100px)': { gridArea: 'known' },
  },
  structure: { minWidth: 0, '@media (min-width: 1100px)': { gridArea: 'structure' } },
  more: { minWidth: 0, '@media (min-width: 1100px)': { gridArea: 'more' } },
  manage: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: cg.space[3],
    paddingTop: cg.space[2],
  },
  manageText: { margin: 0, color: cg.textSecondary },
});

const PAGE_HELP = (
  <>
    <p>
      The facts and structure of one case: what it is about, how it was received and screened, and
      the case structure, which is the case as sections with every value traced to its source.
    </p>
    <p>
      Use “What was known then” to see the case as it stood at an earlier moment. Everything on the
      page then shows only what was known at that moment, and the recorded resolution is hidden
      because it is hindsight.
    </p>
    <p>
      To read the case from the verdict to what to do next, open the review; the other pages are the
      detail behind it.
    </p>
  </>
);

type TwinQuery = ReturnType<typeof useTwin>;
type AnalysisQuery = ReturnType<typeof useLatestRun>;

/**
 * The case structure of the case, or of the moment `asOf` names. The structure of another moment is never shown while
 * this one loads (the card shows its loading state): every section and sentence would describe a moment other than the
 * one named above it. A refetch of the same moment keeps it.
 */
function useTwin(caseId: string, asOf: string | null, enabled: boolean) {
  const request = { params: { caseId }, query: asOf ? { asOf } : {} };
  return useApiQuery(
    'twin.get',
    { ...request, ...asOfCall(asOf) },
    { enabled, placeholderData: keepWithinBoundary(request), ...asOfFresh(asOf) },
  );
}

function useLatestRun(caseId: string, enabled: boolean) {
  return useApiQuery('analysis.latest', { params: { caseId } }, { enabled });
}

type KnownQuery = ReturnType<typeof useKnownAt>;

interface BodyProps {
  caseId: string;
  detail: CaseDetail;
  refreshing: boolean;
  cursor: ReturnType<typeof useAsOfCursor>;
  twin: TwinQuery;
  analysis: AnalysisQuery;
  known: KnownQuery;
  onRefresh: () => void;
  onDeleted: () => void;
}

/** What Case details shows once the case itself has loaded; the case structure and the review run load on their own. */
function CaseDetailsBody({
  caseId,
  detail,
  refreshing,
  cursor,
  twin,
  analysis,
  known,
  onRefresh,
  onDeleted,
}: BodyProps) {
  const styles = useStyles();
  const { asOf, setAsOf } = cursor;
  const review = useReviewRun(detail);
  const run: AnalysisRun | null | undefined = analysis.data?.run;
  const knownEvents =
    asOf && known.data
      ? Math.max(0, detail.eventCount - known.data.withheldFutureEventCount)
      : null;
  const knownSummary = known.data
    ? {
        evidenceCount: known.data.knownAtAsOf.evidenceCount,
        claimCount: known.data.knownAtAsOf.claimCount,
        criticalMissingCount: known.data.knownAtAsOf.criticalMissingCount,
        openWarningCount: known.data.knownAtAsOf.openWarningCount,
        withheldFutureEventCount: known.data.withheldFutureEventCount,
        cutAt: known.data.asOf,
      }
    : null;
  // An earlier view is metered: when the budget is empty the page says so and counts down, it does not fail.
  const twinLimited = asOf !== null && twin.isError && isRateLimited(twin.error);
  const knownLimited = asOf !== null && known.isError && isRateLimited(known.error);
  const retryEarlierViews = (): void => {
    void twin.refetch();
    void known.refetch();
  };

  const structure =
    twinLimited && twin.error ? (
      <AsOfLimited
        key={twin.errorUpdatedAt}
        error={twin.error}
        subject="the case structure"
        onRetry={retryEarlierViews}
        retrying={twin.isFetching || known.isFetching}
        onWholeRecord={() => setAsOf(null)}
      />
    ) : twin.isError && isNotAnalysedError(twin.error) ? (
      <Card>
        <EmptyState
          headingLevel={2}
          icon={<FileSearchIcon />}
          title="No case structure yet"
          description={
            review.busy
              ? 'The review is running. The case structure appears here when it finishes.'
              : 'The review builds the case structure. Run the review and it appears here.'
          }
          {...(review.busy
            ? {}
            : {
                action: (
                  <RunReviewButton review={review} failed={detail.analysisState === 'failed'} />
                ),
              })}
        />
      </Card>
    ) : twin.isError ? (
      <QueryErrorState
        error={twin.error}
        subject="The case structure"
        onRetry={() => void twin.refetch()}
        retrying={twin.isFetching}
      />
    ) : twin.data ? (
      <TwinPanel caseId={caseId} twin={twin.data} asOf={asOf} />
    ) : (
      <TwinSkeleton />
    );

  return (
    <div className={mergeClasses(styles.page, refreshing && styles.busy)}>
      {review.showJob && review.job ? (
        <JobProgress
          jobId={review.job.id}
          title="Review in progress"
          level={2}
          onTerminal={review.onTerminal}
        />
      ) : null}
      <BlurFade index={0}>
        <KeyFacts
          detail={detail}
          asOf={asOf}
          knownEvents={knownEvents}
          links={
            <CaseLinks
              caseId={caseId}
              asOf={asOf}
              counts={asOf === null && run?.status === 'succeeded' ? run.counts : null}
            />
          }
        />
      </BlurFade>
      <div className={styles.columns}>
        <BlurFade index={1} className={styles.known}>
          {knownLimited && !twinLimited && known.error ? (
            <AsOfLimited
              key={known.errorUpdatedAt}
              error={known.error}
              subject="what was known"
              compact
              onRetry={() => void known.refetch()}
              retrying={known.isFetching}
              onWholeRecord={() => setAsOf(null)}
            />
          ) : null}
          <WhatWasKnown
            caseId={caseId}
            range={caseTimeRange(detail)}
            asOf={asOf}
            onChange={setAsOf}
            instants={cursor.instants}
            instantsFailed={cursor.instantsFailed}
            onRetryInstants={cursor.retryInstants}
            known={knownSummary}
            loading={known.isPending && asOf !== null}
            limited={knownLimited || twinLimited}
            decisionsNote={false}
          />
        </BlurFade>
        <BlurFade index={2} className={styles.structure}>
          {structure}
        </BlurFade>
        <BlurFade index={3} className={styles.more}>
          <Panel title="More about this case" level={2}>
            <Accordion>
              <AccordionItem
                title="How it was received"
                subtitle={receivedSubtitle(detail)}
                badge={<ReceivedFlags detail={detail} />}
              >
                <ReceivedDetails detail={detail} />
              </AccordionItem>
              <AccordionItem
                title="How the review was made"
                subtitle={runSubtitle(run, analysis.isPending)}
                badge={run?.simulated ? <ProvenanceBadge kind="simulated" /> : null}
                defaultOpen={detail.analysisState !== 'analyzed'}
              >
                <ReviewRunDetails
                  run={run}
                  live={review.busy}
                  loading={analysis.isPending}
                  error={analysis.error}
                  onRetry={() => void analysis.refetch()}
                  asOf={asOf}
                />
              </AccordionItem>
              <AccordionItem
                title="Recorded resolution"
                subtitle={
                  asOf === null
                    ? 'Never used to generate anything'
                    : 'Hidden while an earlier moment is shown'
                }
                badge={<KnownLaterBadge />}
              >
                <ResolutionDetails detail={detail} asOf={asOf} />
              </AccordionItem>
            </Accordion>
          </Panel>
        </BlurFade>
      </div>
      <BlurFade index={4} className={styles.manage}>
        <p className={styles.manageText}>The record itself cannot be edited.</p>
        <CaseMenu
          detail={detail}
          review={review}
          onRefresh={onRefresh}
          refreshing={refreshing}
          onDeleted={onDeleted}
        />
      </BlurFade>
    </div>
  );
}

/**
 * Case details (`/cases/[caseId]`): the facts and structure of one case. Key facts and the case in numbers first, then the
 * case structure (the digital twin, with `asOf`) beside the folded sections (what was known then, how the case was
 * received, how the review was made, the hindsight-labelled resolution), then the case's own management. The moment
 * lives in the URL and applies to the structure; facts that only the finished record knows are hidden while it is set.
 */
export function CaseOverviewPage({ caseId }: { caseId: string }) {
  const auth = useAuth();
  const router = useRouter();
  const ready = auth.status === 'ready';
  const cursor = useAsOfCursor(caseId);
  const detail = useCaseDetail(caseId);
  const analysis = useLatestRun(caseId, ready);
  const twin = useTwin(caseId, cursor.asOf, ready && cursor.ready);
  const known = useKnownAt(caseId, cursor.asOf, cursor.ready);

  // A case that does not exist has nothing to wait for and nothing to retry: say so, instead of failing on each read.
  if (detail.isError && detail.error.isNotFound) return <CaseNotFoundState />;

  return (
    <>
      <PageHeader
        title="Case details"
        description="Read the facts and structure of the case."
        help={PAGE_HELP}
        actions={
          <ButtonLink
            href={caseHref(caseId, 'review')}
            variant="primary"
            icon={<ClipboardCheckIcon />}
          >
            Open review
          </ButtonLink>
        }
      />
      <QueryBoundary query={detail} subject="The case" skeleton={<CaseDetailsSkeleton />}>
        {(value, meta) => (
          <CaseDetailsBody
            caseId={caseId}
            detail={value}
            refreshing={meta.isRefreshing}
            cursor={cursor}
            twin={twin}
            analysis={analysis}
            known={known}
            onRefresh={() => {
              void detail.refetch();
              void analysis.refetch();
              void twin.refetch();
            }}
            onDeleted={() => router.push('/cases')}
          />
        )}
      </QueryBoundary>
    </>
  );
}
