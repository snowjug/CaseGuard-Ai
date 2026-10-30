'use client';

import type { HypothesesResponse } from '@caseguard/schemas';
import {
  EmptyState,
  LoadingSkeleton,
  PageHeader,
  ProvenanceBadge,
  cg,
  formatDateTimeUtc,
} from '@caseguard/ui';
import { Button, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  ArrowSyncRegular,
  BeakerRegular,
  LightbulbRegular,
  TargetRegular,
} from '@fluentui/react-icons';
import { useMemo } from 'react';
import { AsOfPanel } from '../../components/case/AsOfPanel';
import {
  AsOfLimited,
  isRateLimited,
  snapToEvent,
  useAsOfCursor,
} from '../../components/case/as-of';
import { caseTimeRange, useKnownAt } from '../../components/case/case-hooks';
import { LinkButton } from '../../components/common/LinkButton';
import { QueryBoundary } from '../../components/common/QueryBoundary';
import { QueryErrorState } from '../../components/common/QueryErrorState';
import { useAuth } from '../../lib/auth/context';
import { caseHref } from '../../lib/deep-links';
import { codecs, useSelectionState, useUrlState } from '../../lib/url-state';
import { useCaseDetail, useInvalidate } from '../reasoning/hooks';
import { LookingUp } from '../reasoning/LookingUp';
import { instantBefore } from '../reasoning/time';
import { ActionValuePanel } from './ActionValuePanel';
import { ConfidencePanel } from './ConfidencePanel';
import { HypothesisDetail } from './HypothesisDetail';
import { HypothesisList } from './HypothesisList';
import { useActionRanking, useActions, useDecisionPoint, useForks, useHypotheses } from './hooks';
import {
  chartMarkers,
  cursorView,
  decisionPointView,
  findHypothesis,
  hasNothingToRank,
} from './model';
import { ArenaSkeleton } from './Skeleton';

const CHART_CODEC = codecs.enumOf(['top', 'all'] as const, 'top');
const RANKING_ANCHOR = 'action-ranking';

const useStyles = makeStyles({
  page: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  busy: { opacity: 0.72 },
  context: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${cg.space[2]} ${cg.space[3]}`,
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    color: cg.textSecondary,
  },
  actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  shortcuts: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  band: {
    display: 'grid',
    gap: cg.space[4],
    gridTemplateColumns: 'minmax(0, 1fr)',
    alignItems: 'start',
    '@media (min-width: 1100px)': { gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 3fr)' },
  },
  sticky: {
    '@media (min-width: 1100px)': {
      position: 'sticky',
      top: 'calc(var(--cg-shell-top, 84px) + 12px)',
    },
  },
});

const PAGE_HELP =
  'The Arena keeps competing explanations alive instead of choosing a root cause early. Every confidence is a model estimate from an authored knowledge pack, shown with its range. Use the time cursor to see the case as it stood at any moment: it lands on an event, because nothing changes between two events, and nothing later than the cursor is requested or shown. While a moment loads, the page shows only that it is loading, never the numbers of another moment. Each earlier view is computed once by the server and then kept; computing many new ones in a short time is limited, and the page says so and counts down. The ranking at the bottom explains which diagnostic action would be worth taking next, and a reviewer can override it, with a recorded reason, on the ranking at the moment shown; the overrides are listed under it. When the last event of a resolved case has nothing left to rank, the ranking just before the earliest meaningful decision fork is shown instead.';

function RankingSection({
  caseId,
  asOf,
  ready,
  lastInstant,
  caseResolved,
  onWholeRecord,
}: {
  caseId: string;
  asOf: string | null;
  ready: boolean;
  lastInstant: string | null;
  caseResolved: boolean;
  onWholeRecord: () => void;
}) {
  // The ranking the time cursor asks for: the whole record (the last event) or an earlier moment.
  const cursorRanking = useActionRanking(caseId, asOf, ready);
  // A resolved case has nothing left to rank at its last event; its default ranking is the one just before the earliest
  // meaningful decision fork. The cursor is untouched: an earlier moment the person chose is always shown as it is.
  const nothingLeft =
    asOf === null && cursorRanking.data !== undefined && hasNothingToRank(cursorRanking.data);
  const decision = useDecisionPoint(caseId, nothingLeft);
  const decisionRanking = useActionRanking(
    caseId,
    decision.asOf,
    ready && nothingLeft && decision.asOf !== null,
  );
  const skeleton = <LoadingSkeleton variant="table" count={4} label="Loading the action ranking" />;

  if (cursorRanking.isPending) return skeleton;
  if (cursorRanking.isError) {
    if (asOf !== null && isRateLimited(cursorRanking.error)) {
      return (
        <AsOfLimited
          key={cursorRanking.errorUpdatedAt}
          error={cursorRanking.error}
          subject="the action ranking"
          onRetry={() => void cursorRanking.refetch()}
          retrying={cursorRanking.isFetching}
          onWholeRecord={onWholeRecord}
        />
      );
    }
    return (
      <QueryErrorState
        compact
        subject="The action ranking"
        error={cursorRanking.error}
        onRetry={() => void cursorRanking.refetch()}
        retrying={cursorRanking.isFetching}
      />
    );
  }

  const view = cursorView(cursorRanking.data, { asOf, lastInstant, caseResolved });
  if (!nothingLeft) {
    return <ActionValuePanel caseId={caseId} view={view} onShowLatest={onWholeRecord} />;
  }
  if (decision.pending) return skeleton;
  if (decision.fork === null || decision.asOf === null) {
    return <ActionValuePanel caseId={caseId} view={view} />;
  }
  if (decisionRanking.isPending) return skeleton;
  if (decisionRanking.isError) {
    return isRateLimited(decisionRanking.error) ? (
      <AsOfLimited
        key={decisionRanking.errorUpdatedAt}
        error={decisionRanking.error}
        subject="the ranking just before the earliest decision fork"
        onRetry={() => void decisionRanking.refetch()}
        retrying={decisionRanking.isFetching}
      />
    ) : (
      <QueryErrorState
        compact
        subject="The action ranking"
        error={decisionRanking.error}
        onRetry={() => void decisionRanking.refetch()}
        retrying={decisionRanking.isFetching}
      />
    );
  }
  return (
    <ActionValuePanel
      caseId={caseId}
      view={decisionPointView(
        decisionRanking.data,
        cursorRanking.data,
        decision.fork,
        caseResolved,
      )}
    />
  );
}

function Content({
  caseId,
  asOf,
  ready,
  data,
  isRefreshing,
  chartEvents,
  lastInstant,
  caseResolved,
  onWholeRecord,
}: {
  caseId: string;
  asOf: string | null;
  ready: boolean;
  data: HypothesesResponse;
  isRefreshing: boolean;
  chartEvents: ReturnType<typeof chartMarkers>;
  lastInstant: string | null;
  caseResolved: boolean;
  onWholeRecord: () => void;
}) {
  const styles = useStyles();
  const [selection, select] = useSelectionState();
  const [chart, setChart] = useUrlState('chart', CHART_CODEC);
  const selected = findHypothesis(data.items, selection) ?? data.items[0];

  return (
    <div
      className={mergeClasses(styles.page, isRefreshing && styles.busy)}
      aria-busy={isRefreshing}
    >
      <ConfidencePanel
        hypotheses={data.items}
        markers={chartEvents}
        focusId={selected?.id ?? null}
        showAll={chart === 'all'}
        onShowAllChange={(value) => setChart(value ? 'all' : 'top')}
        asOf={data.asOf}
      />
      <div className={styles.band}>
        <div className={styles.sticky}>
          <HypothesisList
            hypotheses={data.items}
            selectedId={selected?.id ?? null}
            onSelect={select}
          />
        </div>
        {selected ? (
          <HypothesisDetail
            hypothesis={selected}
            data={data}
            caseId={caseId}
            rankingHref={`#${RANKING_ANCHOR}`}
          />
        ) : null}
      </div>
      <div id={RANKING_ANCHOR}>
        <RankingSection
          caseId={caseId}
          asOf={asOf}
          ready={ready}
          lastInstant={lastInstant}
          caseResolved={caseResolved}
          onWholeRecord={onWholeRecord}
        />
      </div>
    </div>
  );
}

/**
 * Hypothesis Arena (`/cases/[caseId]/hypotheses`): the competing explanations with model-estimated confidence over
 * time, the evidence for and against each, the cheapest safe validating action and the action-value ranking with its
 * transparent calculation, sensitivity and audited reviewer override. Everything follows the time cursor (`?asOf=`, which
 * always lands on an event: an earlier view is computed once per window and metered, so it is requested once, after the
 * cursor rests, and a refusal is shown with its countdown); `?sel=` is the selected hypothesis and `?chart=all` draws
 * every line.
 */
export function HypothesisArenaPage({ caseId }: { caseId: string }) {
  const styles = useStyles();
  const auth = useAuth();
  const cursor = useAsOfCursor(caseId);
  const { asOf, setAsOf, ready } = cursor;
  const caseQuery = useCaseDetail(caseId);
  const invalidate = useInvalidate();
  const hypotheses = useHypotheses(caseId, asOf, ready);
  const forks = useForks(caseId, asOf, ready);
  const actions = useActions(caseId, asOf, ready);
  const known = useKnownAt(caseId, asOf, ready);

  const markers = useMemo(
    () => chartMarkers(actions.data?.items ?? [], forks.data?.items ?? []),
    [actions.data, forks.data],
  );
  const earliest = forks.data?.items.find((fork) => fork.isEarliestMeaningful) ?? null;
  const decisionMoment = earliest
    ? snapToEvent(instantBefore(earliest.timestamp), cursor.instants ?? [])
    : null;
  const detail = caseQuery.data;
  const lastInstant =
    cursor.instants?.[cursor.instants.length - 1] ?? caseTimeRange(detail)?.max ?? null;
  const caseResolved = detail?.status === 'resolved' || detail?.status === 'closed';
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
  // An earlier view is metered: when the budget is empty (reason `engine_budget`) the page says so and counts down.
  const knownLimited = asOf !== null && known.isError && isRateLimited(known.error);
  const hypothesesLimited = asOf !== null && hypotheses.isError && isRateLimited(hypotheses.error);

  const refresh = (): void => {
    void invalidate(['hypotheses.list', 'forks.list', 'actions.list', 'actionValue.rank']);
    if (asOf !== null) void known.refetch();
  };
  const retryEarlierViews = (): void => {
    void hypotheses.refetch();
    if (forks.isError) void forks.refetch();
    if (actions.isError) void actions.refetch();
    if (known.isError) void known.refetch();
  };
  const wholeRecord = (): void => setAsOf(null);

  return (
    <>
      <PageHeader
        title="Hypothesis Arena"
        description="Competing explanations for the case, each with model-estimated confidence, the evidence for and against it and the cheapest safe way to test it."
        help={PAGE_HELP}
        meta={
          <>
            <ProvenanceBadge kind="estimated" label="Model estimates" />
            {detail?.synthetic ? <ProvenanceBadge kind="synthetic" /> : null}
          </>
        }
        actions={
          <div className={styles.actions}>
            <LinkButton
              href={caseHref(caseId, 'counterfactual')}
              appearance="outline"
              icon={<BeakerRegular />}
            >
              Counterfactual Lab
            </LinkButton>
            <Button
              appearance="outline"
              icon={<ArrowSyncRegular />}
              disabled={auth.status !== 'ready' || hypotheses.isFetching}
              onClick={refresh}
            >
              {hypotheses.isFetching && !hypotheses.isPending ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>
        }
      />
      {detail ? (
        <p className={styles.context}>
          <strong>{detail.reference}</strong>
          <span>{detail.title}</span>
        </p>
      ) : null}
      <AsOfPanel
        caseId={caseId}
        range={caseTimeRange(detail)}
        asOf={asOf}
        onChange={setAsOf}
        instants={cursor.instants}
        known={knownSummary}
        loading={known.isPending && asOf !== null}
        limited={knownLimited}
        decisionsNote={false}
        linkTo={['timeline', 'evidence']}
      />
      {earliest && decisionMoment ? (
        <div className={styles.shortcuts}>
          <Button
            appearance="primary"
            icon={<TargetRegular />}
            disabled={asOf === decisionMoment}
            onClick={() => setAsOf(decisionMoment)}
          >
            Just before the earliest meaningful decision fork
          </Button>
          <LinkButton
            href={`${caseHref(caseId, 'counterfactual')}?sel=${encodeURIComponent(earliest.id)}`}
            appearance="outline"
            icon={<BeakerRegular />}
          >
            Simulate a safer path from {formatDateTimeUtc(earliest.timestamp)}
          </LinkButton>
        </div>
      ) : null}
      {hypothesesLimited && hypotheses.error ? (
        <AsOfLimited
          key={hypotheses.errorUpdatedAt}
          error={hypotheses.error}
          subject="the hypothesis view"
          onRetry={retryEarlierViews}
          retrying={hypotheses.isFetching}
          onWholeRecord={wholeRecord}
        />
      ) : (
        <QueryBoundary
          query={hypotheses}
          subject="The Hypothesis Arena"
          skeleton={
            // The "What was known" panel already says which moment it is looking up while its own counts load.
            asOf && !known.isPending ? (
              <>
                <LookingUp asOf={asOf} />
                <ArenaSkeleton />
              </>
            ) : (
              <ArenaSkeleton />
            )
          }
          isEmpty={(value) => value.items.length === 0}
          empty={
            <EmptyState
              headingLevel={2}
              icon={<LightbulbRegular />}
              title="No hypotheses yet"
              description="Hypotheses appear once the case has been analysed. Open the case to see its analysis status."
              action={
                <LinkButton href={caseHref(caseId)} appearance="primary">
                  Open the case
                </LinkButton>
              }
            />
          }
        >
          {(value, meta) => (
            <Content
              caseId={caseId}
              asOf={asOf}
              ready={ready}
              data={value}
              isRefreshing={meta.isRefreshing}
              chartEvents={markers}
              lastInstant={lastInstant}
              caseResolved={caseResolved}
              onWholeRecord={wholeRecord}
            />
          )}
        </QueryBoundary>
      )}
    </>
  );
}
