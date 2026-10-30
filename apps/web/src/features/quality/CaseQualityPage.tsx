'use client';

import type { AnalysisState, CaseDetail } from '@caseguard/schemas';
import { EmptyState, LoadingSkeleton, PageHeader, ProvenanceBadge, cg } from '@caseguard/ui';
import { Button, Tab, TabList, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  ArrowSyncRegular,
  BeakerRegular,
  FolderRegular,
  SearchRegular,
} from '@fluentui/react-icons';
import { useId, type ReactNode } from 'react';
import { type AsOfCursor, useAsOfCursor } from '../../components/case/as-of';
import { useKnownAt } from '../../components/case/case-hooks';
import { LinkButton } from '../../components/common/LinkButton';
import { PermissionGate } from '../../components/common/PermissionGate';
import { QueryErrorState } from '../../components/common/QueryErrorState';
import { useApiQuery } from '../../lib/api/hooks';
import { useAuth } from '../../lib/auth/context';
import { caseHref } from '../../lib/deep-links';
import { ANALYSIS_STATE_BADGES } from '../../lib/labels';
import { useTabState } from '../../lib/url-state';
import { CaseSkillMatches } from '../skills/CaseSkillMatches';
import { AsOfBar } from './AsOfBar';
import {
  caseTimeRange,
  useCaseRecord,
  useMetricsAt,
  useQualityAt,
  useWarningsAt,
} from './case-hooks';
import { CoachingView } from './CoachingView';
import { CompareView } from './CompareView';
import { MetricsView } from './MetricsView';
import { PanelBoundary } from './PanelBoundary';
import { QualityIndexView } from './QualityIndexPanel';
import { useInsightStyles } from './styles';
import { WarningsView } from './WarningsView';

const TABS = ['index', 'effort', 'warnings', 'skills', 'coaching', 'compare'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
  index: 'Quality index',
  effort: 'Effort and metrics',
  warnings: 'Live warnings',
  skills: 'SkillDNA',
  coaching: 'Coaching',
  compare: 'Compare cases',
};

const useStyles = makeStyles({
  tabs: {
    overflowX: 'auto',
    maxWidth: '100%',
    borderBottom: `1px solid ${cg.borderSubtle}`,
  },
  context: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    color: cg.textSecondary,
    overflowWrap: 'anywhere',
  },
});

const PAGE_HELP = (
  <>
    <p>
      The case review shows how well the investigation went, as estimates you can open and question:
      the Case Quality Index with its penalties and improvements, Avoidable Support Effort, the live
      warnings an engineer would have seen, the SkillDNA that fits, a coaching report and a
      comparison with another case.
    </p>
    <p>
      Use the time cursor to see the case as it stood at an earlier moment: the index, metrics,
      warnings and skill matches then use only what was on record by then. Coaching and the
      comparison review the finished case and say so.
    </p>
    <p>Nothing here rates a person: it is about the case and the process.</p>
  </>
);

function CaseMissing() {
  return (
    <EmptyState
      headingLevel={2}
      icon={<FolderRegular />}
      title="We could not find that case"
      description="It may have been deleted, or the address may be mistyped."
      action={
        <LinkButton href="/cases" appearance="primary" icon={<FolderRegular />}>
          Browse cases
        </LinkButton>
      }
    />
  );
}

function NotAnalysed({
  caseId,
  state,
  onRefresh,
}: {
  caseId: string;
  state: AnalysisState;
  onRefresh: () => void;
}) {
  const running = state === 'queued' || state === 'running';
  return (
    <EmptyState
      headingLevel={2}
      icon={<SearchRegular />}
      title={
        state === 'failed'
          ? 'The analysis of this case failed'
          : running
            ? 'This case is being analysed'
            : 'This case has not been analysed yet'
      }
      description={
        running
          ? `The review appears when the analysis finishes (${ANALYSIS_STATE_BADGES[state].label.toLowerCase()}). Refresh in a moment.`
          : 'The quality review is built from the analysis of the case. Open the case to start (or restart) the analysis; this page fills in once it has run.'
      }
      action={
        <LinkButton href={caseHref(caseId)} appearance="primary">
          Open the case
        </LinkButton>
      }
      secondaryAction={
        running ? (
          <Button appearance="outline" icon={<ArrowSyncRegular />} onClick={onRefresh}>
            Refresh
          </Button>
        ) : undefined
      }
    />
  );
}

function IndexTab({ caseId, cursor }: { caseId: string; cursor: AsOfCursor }) {
  const styles = useInsightStyles();
  const { asOf, ready, setAsOf } = cursor;
  const query = useQualityAt(caseId, asOf, ready);
  return (
    <PanelBoundary
      query={query}
      subject="The quality index"
      asOf={asOf}
      onWholeRecord={() => setAsOf(null)}
      skeleton={<LoadingSkeleton variant="card" count={3} label="Loading the quality index" />}
    >
      {(assessment, meta) => (
        <div
          className={mergeClasses(styles.page, meta.isRefreshing && styles.busy)}
          aria-busy={meta.isRefreshing}
        >
          <QualityIndexView assessment={assessment} caseId={caseId} />
        </div>
      )}
    </PanelBoundary>
  );
}

function EffortTab({ caseId, cursor }: { caseId: string; cursor: AsOfCursor }) {
  const styles = useInsightStyles();
  const { asOf, ready, setAsOf } = cursor;
  const query = useMetricsAt(caseId, asOf, ready);
  return (
    <PanelBoundary
      query={query}
      subject="The metrics"
      asOf={asOf}
      onWholeRecord={() => setAsOf(null)}
      skeleton={<LoadingSkeleton variant="metric" count={4} label="Loading the metrics" />}
    >
      {(data, meta) => (
        <div
          className={mergeClasses(styles.page, meta.isRefreshing && styles.busy)}
          aria-busy={meta.isRefreshing}
        >
          <MetricsView metrics={data.items} caseId={caseId} asOf={asOf} />
        </div>
      )}
    </PanelBoundary>
  );
}

function WarningsTab({ caseId, cursor }: { caseId: string; cursor: AsOfCursor }) {
  const styles = useInsightStyles();
  const { asOf, ready, setAsOf } = cursor;
  const query = useWarningsAt(caseId, asOf, ready);
  return (
    <PanelBoundary
      query={query}
      subject="The warnings"
      asOf={asOf}
      onWholeRecord={() => setAsOf(null)}
      skeleton={<LoadingSkeleton variant="list" count={3} label="Loading the warnings" />}
    >
      {(data, meta) => (
        <div
          className={mergeClasses(styles.page, meta.isRefreshing && styles.busy)}
          aria-busy={meta.isRefreshing}
        >
          <WarningsView
            caseId={caseId}
            asOf={asOf}
            warnings={data.items}
            onReload={() => void query.refetch()}
          />
        </div>
      )}
    </PanelBoundary>
  );
}

function CoachingTab({ caseId, asOf }: { caseId: string; asOf: string | null }) {
  const auth = useAuth();
  const query = useApiQuery(
    'coaching.get',
    { params: { caseId } },
    { enabled: auth.status === 'ready' },
  );
  return (
    <PanelBoundary
      query={query}
      subject="The coaching report"
      skeleton={<LoadingSkeleton variant="card" count={3} label="Loading the coaching report" />}
    >
      {(report) => <CoachingView report={report} caseId={caseId} cursorIgnored={asOf !== null} />}
    </PanelBoundary>
  );
}

function TabContent({
  tab,
  caseId,
  cursor,
}: {
  tab: Tab;
  caseId: string;
  cursor: AsOfCursor;
}): ReactNode {
  switch (tab) {
    case 'index':
      return <IndexTab caseId={caseId} cursor={cursor} />;
    case 'effort':
      return <EffortTab caseId={caseId} cursor={cursor} />;
    case 'warnings':
      return <WarningsTab caseId={caseId} cursor={cursor} />;
    case 'skills':
      return (
        <CaseSkillMatches
          caseId={caseId}
          asOf={cursor.asOf}
          ready={cursor.ready}
          onWholeRecord={() => cursor.setAsOf(null)}
        />
      );
    case 'coaching':
      return <CoachingTab caseId={caseId} asOf={cursor.asOf} />;
    case 'compare':
      return <CompareView caseId={caseId} cursorIgnored={cursor.asOf !== null} />;
  }
}

function Review({ caseId, detail }: { caseId: string; detail: CaseDetail }) {
  const styles = useStyles();
  const insight = useInsightStyles();
  const baseId = useId();
  // The boundary is always an event instant, asked for once the case's event instants are known (the shared protocol of
  // the case pages: an earlier view is metered by the server and one computation serves every instant between events).
  const cursor = useAsOfCursor(caseId);
  const { asOf, setAsOf } = cursor;
  const [tab, setTab] = useTabState(TABS, 'index');
  const known = useKnownAt(caseId, asOf, cursor.ready);

  return (
    <div className={insight.page}>
      <AsOfBar
        range={caseTimeRange(detail)}
        asOf={asOf}
        onChange={setAsOf}
        instants={cursor.instants}
        known={known.data}
        knownError={known.isError ? known.error : null}
        loading={asOf !== null && known.isPending}
      />
      <div className={styles.tabs}>
        <TabList
          selectedValue={tab}
          onTabSelect={(_event, data) => setTab(data.value as Tab)}
          aria-label="Quality review sections"
        >
          {TABS.map((value) => (
            <Tab
              key={value}
              value={value}
              id={`${baseId}-tab-${value}`}
              aria-controls={`${baseId}-panel-${value}`}
            >
              {TAB_LABELS[value]}
            </Tab>
          ))}
        </TabList>
      </div>
      <div
        role="tabpanel"
        id={`${baseId}-panel-${tab}`}
        aria-labelledby={`${baseId}-tab-${tab}`}
        className={insight.page}
      >
        <TabContent tab={tab} caseId={caseId} cursor={cursor} />
      </div>
    </div>
  );
}

function ReviewBody({ caseId }: { caseId: string }) {
  const record = useCaseRecord(caseId);
  if (record.isPending) {
    return <LoadingSkeleton variant="card" count={2} label="Loading the case" />;
  }
  if (record.isError) {
    if (record.error.isNotFound) return <CaseMissing />;
    return (
      <QueryErrorState
        subject="The case"
        error={record.error}
        onRetry={() => void record.refetch()}
        retrying={record.isFetching}
      />
    );
  }
  const detail = record.data;
  if (detail.analysisState !== 'analyzed') {
    return (
      <NotAnalysed
        caseId={caseId}
        state={detail.analysisState}
        onRefresh={() => void record.refetch()}
      />
    );
  }
  return <Review caseId={caseId} detail={detail} />;
}

/**
 * Case Quality Review (`/cases/[caseId]/quality`): the Case Quality Index, Avoidable Support Effort and metrics, live
 * warnings, SkillDNA matches, coaching and a comparison with another case. The time cursor (`?asOf=`) recomputes the index,
 * metrics, warnings and matches from only what was known then; coaching and the comparison are retrospective and say so.
 * `?tab=` picks the section, `?wstate=` / `?wcat=` filter the warnings and `?with=` picks the comparison case.
 */
export function CaseQualityPage({ caseId }: { caseId: string }) {
  const styles = useStyles();
  const record = useCaseRecord(caseId);
  const detail = record.data;
  return (
    <>
      <PageHeader
        title="Case Quality Review"
        description="How well the investigation went, as estimates you can open and question."
        help={PAGE_HELP}
        meta={
          <>
            <ProvenanceBadge kind="estimated" />
            {detail?.synthetic ? <ProvenanceBadge kind="synthetic" /> : null}
          </>
        }
        actions={
          <>
            <LinkButton href={caseHref(caseId)} appearance="outline" icon={<FolderRegular />}>
              Case overview
            </LinkButton>
            <LinkButton
              href={caseHref(caseId, 'counterfactual')}
              appearance="outline"
              icon={<BeakerRegular />}
            >
              Counterfactual Lab
            </LinkButton>
          </>
        }
      />
      {detail ? (
        <p className={styles.context}>
          <strong>{detail.reference}</strong> · {detail.title}
        </p>
      ) : null}
      <PermissionGate
        permission="quality:read"
        subject="the case quality review"
        grantedTo="Engineers, reviewers, managers and administrators"
        skeleton={<LoadingSkeleton variant="card" count={2} label="Loading the review" />}
      >
        <ReviewBody caseId={caseId} />
      </PermissionGate>
    </>
  );
}
