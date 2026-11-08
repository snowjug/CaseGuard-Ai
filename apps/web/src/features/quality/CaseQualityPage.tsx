'use client';

import type { AnalysisState, CaseDetail } from '@caseguard/schemas';
import {
  BlurFade,
  Button,
  ButtonLink,
  EmptyState,
  LoadingSkeleton,
  PageHeader,
  ProvenanceBadge,
  TabPanel,
  Tabs,
  cg,
  type TabItem,
} from '@caseguard/ui';
import { makeStyles, mergeClasses } from '@fluentui/react-components';
import { ArrowLeftIcon, FolderSearchIcon, RotateCwIcon, SearchIcon } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { type AsOfCursor, useAsOfCursor } from '../../components/case/as-of';
import { useKnownAt } from '../../components/case/case-hooks';
import { PermissionGate } from '../../components/common/PermissionGate';
import { QueryErrorState } from '../../components/common/QueryErrorState';
import { useApiQuery } from '../../lib/api/hooks';
import { useAuth } from '../../lib/auth/context';
import { caseHref } from '../../lib/deep-links';
import { ANALYSIS_STATE_BADGES } from '../../lib/labels';
import { codecs, useUrlChoiceState } from '../../lib/url-state';
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
import { useLook } from './look';
import { MetricsView } from './MetricsView';
import { PanelBoundary } from './PanelBoundary';
import { ScoreSkeleton } from './ScoreSkeleton';
import { ScoreView } from './ScoreView';
import { WarningsView } from './WarningsView';

const TABS = ['effort', 'warnings', 'skills', 'coaching', 'compare'] as const;
type Tab = (typeof TABS)[number];
const TAB_CODEC = codecs.enumOf(TABS, 'effort');
const TAB_ITEMS: readonly TabItem[] = [
  { value: 'effort', label: 'Effort and metrics' },
  { value: 'warnings', label: 'Warnings' },
  { value: 'skills', label: 'Skills' },
  { value: 'coaching', label: 'Coaching' },
  { value: 'compare', label: 'Compare' },
];

const useStyles = makeStyles({
  more: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[4],
    minWidth: 0,
    // Opening the page on a tab (a link from another page) scrolls here, clear of the sticky top bar.
    scrollMarginTop: '72px',
  },
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[4],
    minWidth: 0,
    paddingTop: cg.space[2],
  },
});

const PAGE_HELP = (
  <>
    <p>
      The Case Quality Index is a model estimate from 0 to 100 of how well the investigation went.
      It is built from six areas and reduced by penalties that each rest on evidence. It helps focus
      a human review; it is not a rating of a person.
    </p>
    <p>
      &ldquo;What was known then&rdquo; shows the score, metrics, warnings and skill matches as they
      stood at an earlier moment. Coaching and the comparison look back at the finished case.
    </p>
  </>
);

function CaseMissing() {
  return (
    <EmptyState
      headingLevel={2}
      icon={<FolderSearchIcon />}
      title="We could not find that case"
      description="It may have been deleted, or the address may be mistyped."
      action={
        <ButtonLink href="/cases" variant="primary">
          Browse cases
        </ButtonLink>
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
      icon={<SearchIcon />}
      title={
        state === 'failed'
          ? 'The analysis of this case failed'
          : running
            ? 'This case is being analysed'
            : 'This case has not been analysed yet'
      }
      description={
        running
          ? `The score appears when the analysis finishes (${ANALYSIS_STATE_BADGES[state].label.toLowerCase()}). Refresh in a moment.`
          : 'The score is built from the analysis of the case. Open the case to start (or restart) the analysis; this page fills in once it has run.'
      }
      action={
        <ButtonLink href={caseHref(caseId)} variant="primary">
          Open case details
        </ButtonLink>
      }
      secondaryAction={
        running ? (
          <Button variant="secondary" icon={<RotateCwIcon />} onClick={onRefresh}>
            Refresh
          </Button>
        ) : undefined
      }
    />
  );
}

function EffortTab({ caseId, cursor }: { caseId: string; cursor: AsOfCursor }) {
  const look = useLook();
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
          className={mergeClasses(look.stack, meta.isRefreshing && look.busy)}
          aria-busy={meta.isRefreshing}
        >
          <MetricsView metrics={data.items} caseId={caseId} asOf={asOf} />
        </div>
      )}
    </PanelBoundary>
  );
}

function WarningsTab({ caseId, cursor }: { caseId: string; cursor: AsOfCursor }) {
  const look = useLook();
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
          className={mergeClasses(look.stack, meta.isRefreshing && look.busy)}
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

function ScorePage({ caseId, detail }: { caseId: string; detail: CaseDetail }) {
  const styles = useStyles();
  const look = useLook();
  // The boundary is always an event instant, asked for once the case's event instants are known (the shared protocol of
  // the case pages: an earlier view is metered by the server and one computation serves every instant between events).
  const cursor = useAsOfCursor(caseId);
  const { asOf, setAsOf } = cursor;
  const [tab, setTab] = useUrlChoiceState('tab', TAB_CODEC, { history: 'push' });
  const known = useKnownAt(caseId, asOf, cursor.ready);
  const quality = useQualityAt(caseId, asOf, cursor.ready);

  // A link that names a tab lands on it: once the score is in (so the page stops growing), scroll to the tabs, once.
  const more = useRef<HTMLElement>(null);
  const scrolled = useRef(false);
  const settled = !quality.isPending;
  useEffect(() => {
    if (!settled || scrolled.current) return;
    scrolled.current = true;
    if (new URLSearchParams(window.location.search).has('tab'))
      more.current?.scrollIntoView({ block: 'start' });
  }, [settled]);

  return (
    <div className={look.page}>
      <BlurFade index={0}>
        <AsOfBar
          range={caseTimeRange(detail)}
          asOf={asOf}
          onChange={setAsOf}
          instants={cursor.instants}
          known={known.data}
          knownError={known.isError ? known.error : null}
          loading={asOf !== null && known.isPending}
        />
      </BlurFade>
      <PanelBoundary
        query={quality}
        subject="The score"
        asOf={asOf}
        onWholeRecord={() => setAsOf(null)}
        skeleton={<ScoreSkeleton label="Loading the score" />}
      >
        {(assessment, meta) => (
          <div
            className={mergeClasses(meta.isRefreshing && look.busy)}
            aria-busy={meta.isRefreshing}
          >
            <ScoreView
              assessment={assessment}
              caseId={caseId}
              onWholeRecord={() => setAsOf(null)}
            />
          </div>
        )}
      </PanelBoundary>
      <BlurFade index={5}>
        <section ref={more} className={styles.more} aria-label="More about this score">
          <Tabs
            value={tab}
            onValueChange={(value) => setTab(value as Tab)}
            items={TAB_ITEMS}
            aria-label="Score details"
          >
            <TabPanel value={tab} className={styles.panel}>
              <TabContent tab={tab} caseId={caseId} cursor={cursor} />
            </TabPanel>
          </Tabs>
        </section>
      </BlurFade>
    </div>
  );
}

function ScoreBody({ caseId }: { caseId: string }) {
  const record = useCaseRecord(caseId);
  if (record.isPending) {
    return <ScoreSkeleton label="Loading the case" />;
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
  return <ScorePage caseId={caseId} detail={detail} />;
}

/**
 * Score (`/cases/[caseId]/quality`): how the Case Quality Index was built and what would raise it. The result comes first
 * (the score, its six areas, what lowered it and what would raise it); effort and metrics, warnings, skill matches,
 * coaching and a comparison with another case sit under tabs. The time cursor (`?asOf=`) recomputes the score, metrics,
 * warnings and matches from only what was known then; coaching and the comparison are retrospective and say so. `?tab=`
 * picks the section, `?wstate=` / `?wcat=` filter the warnings and `?with=` picks the comparison case. The case's own
 * name, status and tabs are in the header above, so this page does not repeat them.
 */
export function CaseQualityPage({ caseId }: { caseId: string }) {
  const record = useCaseRecord(caseId);
  const detail = record.data;
  return (
    <>
      <PageHeader
        title="Score"
        description="See how the score was built and what would raise it."
        help={PAGE_HELP}
        meta={
          <>
            <ProvenanceBadge kind="estimated" />
            {detail?.synthetic ? <ProvenanceBadge kind="synthetic" /> : null}
          </>
        }
        actions={
          <ButtonLink href={caseHref(caseId, 'review')} variant="ghost" icon={<ArrowLeftIcon />}>
            Back to review
          </ButtonLink>
        }
      />
      <PermissionGate
        permission="quality:read"
        subject="the case score"
        grantedTo="Engineers, reviewers, managers and administrators"
        skeleton={<ScoreSkeleton label="Loading the score" />}
      >
        <ScoreBody caseId={caseId} />
      </PermissionGate>
    </>
  );
}
