'use client';

import {
  EmptyState,
  LoadingSkeleton,
  PageHeader,
  ProvenanceBadge,
  StatusBadge,
  cg,
} from '@caseguard/ui';
import { Button, makeStyles, mergeClasses } from '@fluentui/react-components';
import { ArrowSyncRegular, FolderRegular, HistoryRegular } from '@fluentui/react-icons';
import { useRouter } from 'next/navigation';
import { AsOfPanel } from '../../components/case/AsOfPanel';
import {
  AsOfLimited,
  asOfCall,
  asOfFresh,
  isRateLimited,
  useAsOfCursor,
} from '../../components/case/as-of';
import { caseTimeRange, useCaseDetail, useKnownAt } from '../../components/case/case-hooks';
import { isNotAnalysedError } from '../../components/case/NotAnalysedState';
import { LinkButton } from '../../components/common/LinkButton';
import { QueryBoundary } from '../../components/common/QueryBoundary';
import { QueryErrorState } from '../../components/common/QueryErrorState';
import { keepWithinBoundary } from '../../lib/api/boundary-placeholder';
import { useApiQuery } from '../../lib/api/hooks';
import { useAuth } from '../../lib/auth/context';
import { caseHref } from '../../lib/deep-links';
import { ANALYSIS_STATE_BADGES, CASE_STATUS_LABELS, SEVERITY_LABELS } from '../../lib/labels';
import { AnalysisPanel } from './AnalysisPanel';
import { CaseFacts, HindsightPanel, ManagePanel } from './CaseFacts';
import { CaseLinks } from './CaseLinks';
import { CaseOverviewSkeleton } from './Skeletons';
import { TwinPanel } from './TwinPanel';

const useStyles = makeStyles({
  page: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  busy: { opacity: 0.72 },
  columns: {
    display: 'grid',
    gap: cg.space[4],
    gridTemplateColumns: 'minmax(0, 1fr)',
    alignItems: 'start',
    '@media (min-width: 1100px)': { gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)' },
  },
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
});

const PAGE_HELP = (
  <>
    <p>
      The overview is the starting point for one case: its key facts, how it was received and
      screened, the state of its analysis, and the digital twin, which is the case as structured
      sections with every value traced to its source.
    </p>
    <p>
      Use the time cursor to see the case as it stood earlier. Everything on the page then shows
      only what was known at that moment, and the recorded resolution is hidden because it is
      hindsight.
    </p>
  </>
);

function CaseNotFound() {
  return (
    <EmptyState
      headingLevel={2}
      icon={<FolderRegular />}
      title="We could not find that case"
      description="It may have been deleted, or the address may be mistyped."
      action={
        <LinkButton href="/cases" appearance="primary">
          Browse cases
        </LinkButton>
      }
    />
  );
}

/**
 * Case overview (`/cases/[caseId]`): key facts, source and screening, analysis status and job, the digital twin (with
 * `asOf`), participants, the hindsight-labelled resolution and links to every other case page. The time cursor lives in
 * the URL and applies to the twin; facts that only the finished record knows are hidden while it is set.
 */
export function CaseOverviewPage({ caseId }: { caseId: string }) {
  const styles = useStyles();
  const auth = useAuth();
  const router = useRouter();
  const ready = auth.status === 'ready';
  const cursor = useAsOfCursor(caseId);
  const { asOf, setAsOf } = cursor;
  const detail = useCaseDetail(caseId);
  const analysis = useApiQuery('analysis.latest', { params: { caseId } }, { enabled: ready });
  // The twin of another moment is never shown while this one loads (the panel shows its loading state): every section
  // and sentence would describe a moment other than the one named above it. A refetch of the same moment keeps it.
  const twinRequest = { params: { caseId }, query: asOf ? { asOf } : {} };
  const twin = useApiQuery(
    'twin.get',
    { ...twinRequest, ...asOfCall(asOf) },
    {
      enabled: ready && cursor.ready,
      placeholderData: keepWithinBoundary(twinRequest),
      ...asOfFresh(asOf),
    },
  );
  const known = useKnownAt(caseId, asOf, cursor.ready);

  if (detail.isError && detail.error.isNotFound) {
    return (
      <>
        <PageHeader title="Case not found" description="This case does not exist or was deleted." />
        <CaseNotFound />
      </>
    );
  }

  const data = detail.data;
  const range = caseTimeRange(data);
  const knownEvents =
    asOf && data && known.data
      ? Math.max(0, data.eventCount - known.data.withheldFutureEventCount)
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
  const analysisBadge = data ? ANALYSIS_STATE_BADGES[data.analysisState] : null;
  const run = analysis.data?.run;

  return (
    <>
      <PageHeader
        title={data ? data.title : 'Case overview'}
        description={
          data
            ? `${data.reference} · ${data.product} · ${data.workload} · ${SEVERITY_LABELS[data.severity]}${
                asOf === null ? ` · ${CASE_STATUS_LABELS[data.status]}` : ''
              }`
            : 'Loading the case…'
        }
        help={PAGE_HELP}
        meta={
          data ? (
            <>
              {analysisBadge ? (
                <StatusBadge status={analysisBadge.status} label={analysisBadge.label} />
              ) : null}
              {data.synthetic ? <ProvenanceBadge kind="synthetic" /> : null}
            </>
          ) : null
        }
        actions={
          <div className={styles.actions}>
            <Button
              appearance="outline"
              icon={<ArrowSyncRegular />}
              disabled={!ready || detail.isFetching}
              onClick={() => {
                void detail.refetch();
                void analysis.refetch();
                void twin.refetch();
              }}
            >
              {detail.isFetching && !detail.isPending ? 'Refreshing…' : 'Refresh'}
            </Button>
            <LinkButton
              href={`${caseHref(caseId, 'timeline')}${asOf ? `?asOf=${encodeURIComponent(asOf)}` : ''}`}
              appearance="primary"
              icon={<HistoryRegular />}
            >
              Open the timeline
            </LinkButton>
          </div>
        }
      />
      <QueryBoundary query={detail} subject="The case" skeleton={<CaseOverviewSkeleton />}>
        {(value, meta) => (
          <div className={mergeClasses(styles.page, meta.isRefreshing && styles.busy)}>
            <CaseLinks
              caseId={caseId}
              asOf={asOf}
              counts={asOf === null && run?.status === 'succeeded' ? run.counts : null}
            />
            <div className={styles.columns}>
              <div className={styles.stack}>
                {twinLimited && twin.error ? (
                  <AsOfLimited
                    key={twin.errorUpdatedAt}
                    error={twin.error}
                    subject="the digital twin"
                    onRetry={retryEarlierViews}
                    retrying={twin.isFetching || known.isFetching}
                    onWholeRecord={() => setAsOf(null)}
                  />
                ) : twin.isError && isNotAnalysedError(twin.error) ? (
                  <EmptyState
                    headingLevel={2}
                    icon={<FolderRegular />}
                    title="No digital twin yet"
                    description="The digital twin is built by the analysis. Start the analysis from the panel on this page and it appears here."
                  />
                ) : twin.isError ? (
                  <QueryErrorState
                    error={twin.error}
                    subject="The digital twin"
                    onRetry={() => void twin.refetch()}
                    retrying={twin.isFetching}
                  />
                ) : twin.data ? (
                  <TwinPanel caseId={caseId} twin={twin.data} asOf={asOf} />
                ) : (
                  <LoadingSkeleton variant="list" count={5} label="Loading the digital twin" />
                )}
              </div>
              <div className={styles.stack}>
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
                <AsOfPanel
                  caseId={caseId}
                  range={range}
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
                <AnalysisPanel
                  detail={value}
                  run={run}
                  loading={analysis.isPending}
                  error={analysis.error}
                  onRetry={() => void analysis.refetch()}
                  asOf={asOf}
                />
                <CaseFacts detail={value} asOf={asOf} knownEvents={knownEvents} />
                <HindsightPanel detail={value} asOf={asOf} />
                <ManagePanel detail={value} onDeleted={() => router.push('/cases')} />
              </div>
            </div>
          </div>
        )}
      </QueryBoundary>
    </>
  );
}
