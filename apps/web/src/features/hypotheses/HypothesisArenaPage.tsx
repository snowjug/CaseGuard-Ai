'use client';

import type { HypothesesResponse } from '@caseguard/schemas';
import {
  Badge,
  BlurFade,
  Button,
  ButtonLink,
  Drawer,
  EmptyState,
  IconButton,
  LoadingSkeleton,
  PageHeader,
  ProvenanceBadge,
  Skeleton,
  VisuallyHidden,
  cg,
  formatDateTimeUtc,
} from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  FlaskConicalIcon,
  GitForkIcon,
  LightbulbIcon,
  RefreshCwIcon,
  TargetIcon,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import {
  AsOfLimited,
  isRateLimited,
  snapToEvent,
  useAsOfCursor,
} from '../../components/case/as-of';
import { caseTimeRange, useKnownAt } from '../../components/case/case-hooks';
import { CaseNotFoundState } from '../../components/case/CaseNotFoundState';
import { QueryBoundary } from '../../components/common/QueryBoundary';
import { QueryErrorState } from '../../components/common/QueryErrorState';
import { useAuth } from '../../lib/auth/context';
import { caseHref } from '../../lib/deep-links';
import { codecs, useSelectionState, useUrlState } from '../../lib/url-state';
import { WhatWasKnownBar } from '../evidence/WhatWasKnownBar';
import { useCaseDetail, useInvalidate } from '../reasoning/hooks';
import { LookingUp } from '../reasoning/LookingUp';
import { instantBefore } from '../reasoning/time';
import { ActionValuePanel } from './ActionValuePanel';
import { ConfidencePanel } from './ConfidencePanel';
import { HypothesisDetail } from './HypothesisDetail';
import { HypothesisList } from './HypothesisList';
import { LeadingCause } from './LeadingCause';
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
  strip: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${cg.space[2]} ${cg.space[3]}`,
    padding: `${cg.space[2]} ${cg.space[4]}`,
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderSubtle}`,
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase300,
  },
  stripText: { flex: '1 1 240px', minWidth: 0, overflowWrap: 'anywhere' },
  stripActions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  // The long label of a strip action may wrap on a phone instead of running out of the card.
  wrap: {
    whiteSpace: 'normal',
    textAlign: 'start',
    lineHeight: tokens.lineHeightBase200,
    paddingBlock: cg.space[2],
    maxWidth: '100%',
    minWidth: 0,
    flexShrink: 1,
  },
});

const PAGE_HELP =
  'Possible causes keeps competing explanations alive instead of choosing a root cause early. Every confidence is a model estimate from an authored knowledge pack, shown with its range. Use “What was known then” to see the case as it stood at any moment: it lands on an event, because nothing changes between two events, and nothing later than the cursor is requested or shown. While a moment loads, the page shows only that it is loading, never the numbers of another moment. Each earlier view is computed once by the server and then kept; computing many new ones in a short time is limited, and the page says so and counts down. “What to test next” explains which diagnostic action would be worth taking, and a reviewer can override its ranking, with a recorded reason, at the moment shown; the overrides are listed under it. When the last event of a resolved case has nothing left to rank, the ranking just before the first key decision is shown instead.';

function RankingSection({
  caseId,
  asOf,
  ready,
  lastInstant,
  caseResolved,
  onWholeRecord,
  open,
  onOpenChange,
}: {
  caseId: string;
  asOf: string | null;
  ready: boolean;
  lastInstant: string | null;
  caseResolved: boolean;
  onWholeRecord: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
    return (
      <ActionValuePanel
        caseId={caseId}
        view={view}
        onShowLatest={onWholeRecord}
        open={open}
        onOpenChange={onOpenChange}
      />
    );
  }
  if (decision.pending) return skeleton;
  if (decision.fork === null || decision.asOf === null) {
    return <ActionValuePanel caseId={caseId} view={view} open={open} onOpenChange={onOpenChange} />;
  }
  if (decisionRanking.isPending) return skeleton;
  if (decisionRanking.isError) {
    return isRateLimited(decisionRanking.error) ? (
      <AsOfLimited
        key={decisionRanking.errorUpdatedAt}
        error={decisionRanking.error}
        subject="the ranking just before the first key decision"
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
      open={open}
      onOpenChange={onOpenChange}
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
  keyDecision,
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
  /** The shortcut to the moment before the first key decision, when there is one. */
  keyDecision: ReactNode;
}) {
  const styles = useStyles();
  const [selection, select] = useSelectionState();
  const [chart, setChart] = useUrlState('chart', CHART_CODEC);
  const [rankingOpen, setRankingOpen] = useState(false);
  const leading = data.items[0];
  const selected = findHypothesis(data.items, selection);
  // The drawer slides out with what it showed, not empty: the last cause that was open is kept until it is gone.
  const [lastSelected, setLastSelected] = useState(selected);
  if (selected !== undefined && selected !== lastSelected) setLastSelected(selected);
  const shown = selected ?? lastSelected;

  // The ranking is part of the page, below: the drawer closes and the row opens at it.
  const showRanking = (): void => {
    select(null);
    setRankingOpen(true);
    window.setTimeout(
      () => document.getElementById(RANKING_ANCHOR)?.scrollIntoView({ block: 'start' }),
      50,
    );
  };

  return (
    <div
      className={mergeClasses(styles.page, isRefreshing && styles.busy)}
      aria-busy={isRefreshing}
    >
      {leading ? (
        <BlurFade index={1}>
          <LeadingCause
            hypothesis={leading}
            onOpen={() => select(leading.id)}
            onShowRanking={showRanking}
          />
        </BlurFade>
      ) : null}
      {keyDecision}
      <BlurFade index={2}>
        <HypothesisList
          hypotheses={data.items.slice(1)}
          selectedId={selected?.id ?? null}
          onSelect={select}
        />
      </BlurFade>
      <BlurFade index={3}>
        <ConfidencePanel
          hypotheses={data.items}
          markers={chartEvents}
          focusId={(selected ?? leading)?.id ?? null}
          showAll={chart === 'all'}
          onShowAllChange={(value) => setChart(value ? 'all' : 'top')}
          asOf={data.asOf}
        />
      </BlurFade>
      <BlurFade index={4}>
        <div id={RANKING_ANCHOR}>
          <RankingSection
            caseId={caseId}
            asOf={asOf}
            ready={ready}
            lastInstant={lastInstant}
            caseResolved={caseResolved}
            onWholeRecord={onWholeRecord}
            open={rankingOpen}
            onOpenChange={setRankingOpen}
          />
        </div>
      </BlurFade>
      <Drawer
        open={selected !== undefined}
        onOpenChange={(open) => {
          if (!open) select(null);
        }}
        title={shown?.name ?? 'Possible cause'}
        size="lg"
      >
        {shown ? (
          <HypothesisDetail
            hypothesis={shown}
            data={data}
            caseId={caseId}
            onShowRanking={showRanking}
          />
        ) : null}
      </Drawer>
    </div>
  );
}

/**
 * Possible causes (`/cases/[caseId]/hypotheses`): the competing explanations, the leading one first with its estimated
 * confidence, the others as ranked rows, the evidence for and against each in a drawer, how confidence moved, and the
 * ranking of what to test next with its transparent calculation, sensitivity and audited reviewer override. Everything
 * follows the time cursor (`?asOf=`, which always lands on an event: an earlier view is computed once per window and
 * metered, so it is requested once, after the cursor rests, and a refusal is shown with its countdown); `?sel=` is the
 * open cause and `?chart=all` draws every line.
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

  // A case that does not exist has nothing to wait for and nothing to retry: say so, instead of failing on each read.
  if (caseQuery.isError && caseQuery.error.isNotFound) return <CaseNotFoundState />;

  const keyDecision =
    earliest && decisionMoment ? (
      <div className={styles.strip}>
        <Badge tone="fork" icon={<GitForkIcon />}>
          Key decision
        </Badge>
        <span className={styles.stripText}>
          {earliest.title} · {formatDateTimeUtc(earliest.timestamp)}
        </span>
        <div className={styles.stripActions}>
          <Button
            variant="secondary"
            size="sm"
            icon={<TargetIcon />}
            className={styles.wrap}
            disabled={asOf === decisionMoment}
            onClick={() => setAsOf(decisionMoment)}
          >
            Just before the first key decision
          </Button>
          <ButtonLink
            variant="ghost"
            size="sm"
            icon={<FlaskConicalIcon />}
            className={styles.wrap}
            href={`${caseHref(caseId, 'counterfactual')}?sel=${encodeURIComponent(earliest.id)}`}
          >
            Simulate a safer path from {formatDateTimeUtc(earliest.timestamp)}
          </ButtonLink>
        </div>
      </div>
    ) : null;

  return (
    <>
      <PageHeader
        title="Possible causes"
        description="Compare explanations and decide what to test next."
        help={PAGE_HELP}
        meta={
          <>
            <ProvenanceBadge kind="estimated" />
            {detail?.synthetic ? <ProvenanceBadge kind="synthetic" /> : null}
          </>
        }
        actions={
          <>
            <ButtonLink
              href={caseHref(caseId, 'counterfactual')}
              variant="secondary"
              icon={<FlaskConicalIcon />}
            >
              What if
            </ButtonLink>
            <IconButton
              icon={<RefreshCwIcon />}
              label="Refresh"
              disabled={auth.status !== 'ready'}
              loading={hypotheses.isFetching && !hypotheses.isPending}
              onClick={refresh}
            />
          </>
        }
      />
      <div className={styles.page}>
        <BlurFade>
          {detail ? (
            <WhatWasKnownBar
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
          ) : caseQuery.isError ? null : (
            <div role="status" aria-busy="true" aria-live="polite">
              <VisuallyHidden>Loading what was known…</VisuallyHidden>
              <Skeleton height={58} radius="lg" />
            </div>
          )}
        </BlurFade>
        {hypothesesLimited && hypotheses.error ? (
          <AsOfLimited
            key={hypotheses.errorUpdatedAt}
            error={hypotheses.error}
            subject="the possible causes"
            onRetry={retryEarlierViews}
            retrying={hypotheses.isFetching}
            onWholeRecord={wholeRecord}
          />
        ) : (
          <QueryBoundary
            query={hypotheses}
            subject="The possible causes"
            skeleton={
              // The "What was known then" bar already says which moment it is looking up while its own counts load.
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
                icon={<LightbulbIcon />}
                title="No possible causes yet"
                description="Possible causes appear once the case has been analysed. Open the case to see its analysis status."
                action={
                  <ButtonLink href={caseHref(caseId)} variant="primary">
                    Open the case
                  </ButtonLink>
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
                keyDecision={keyDecision}
              />
            )}
          </QueryBoundary>
        )}
      </div>
    </>
  );
}
