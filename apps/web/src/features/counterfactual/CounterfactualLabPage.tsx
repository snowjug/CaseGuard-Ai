'use client';

import type { CounterfactualScenario, DecisionFork } from '@caseguard/schemas';
import {
  EmptyState,
  LoadingSkeleton,
  Notice,
  PageHeader,
  ProvenanceBadge,
  cg,
} from '@caseguard/ui';
import { Button, Tab, TabList, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  ArrowSyncRegular,
  BeakerRegular,
  BranchForkRegular,
  LightbulbRegular,
} from '@fluentui/react-icons';
import { useMemo } from 'react';
import { AsOfLimited, isRateLimited } from '../../components/case/as-of';
import { LinkButton } from '../../components/common/LinkButton';
import { QueryBoundary } from '../../components/common/QueryBoundary';
import { QueryErrorState } from '../../components/common/QueryErrorState';
import { useAuth } from '../../lib/auth/context';
import { caseHref } from '../../lib/deep-links';
import {
  codecs,
  useSelectionState,
  useTabState,
  useUrlState,
  writeUrlState,
} from '../../lib/url-state';
import { useCaseDetail } from '../reasoning/hooks';
import { BoundaryPanel } from './BoundaryPanel';
import { ComparisonPanel } from './ComparisonPanel';
import { DecisionMoment } from './DecisionMoment';
import { EvidenceInspector, type EvidenceReadState } from './EvidenceInspector';
import { ForkHeader } from './ForkHeader';
import { ForkSelector } from './ForkSelector';
import { GraphPanel } from './GraphPanel';
import { HindsightPanel } from './HindsightPanel';
import { PathsBar } from './PathsBar';
import { ReviewPanel } from './ReviewPanel';
import { LabSkeleton } from './Skeleton';
import { useDecisionTimeEvidence, useForkList, useRecordedActions, useScenarioList } from './hooks';
import { bearingsOf, resolveSelection, scenariosOfFork } from './model';

const TABS = ['compare', 'evidence', 'decision', 'graph', 'review'] as const;
type LabTab = (typeof TABS)[number];
const TAB_LABELS: Record<LabTab, string> = {
  compare: 'Compare paths',
  evidence: 'Evidence behind each step',
  decision: 'Decision moment',
  graph: 'Investigation graph',
  review: 'Review and SkillDNA',
};
const STEP_CODEC = codecs.optionalString();

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
  layout: {
    display: 'grid',
    gap: cg.space[4],
    gridTemplateColumns: 'minmax(0, 1fr)',
    alignItems: 'start',
    '@media (min-width: 1100px)': { gridTemplateColumns: 'minmax(300px, 1fr) minmax(0, 3fr)' },
  },
  side: {
    minWidth: 0,
    '@media (min-width: 1100px)': {
      position: 'sticky',
      top: 'calc(var(--cg-shell-top, 84px) + 12px)',
    },
  },
  main: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  tabs: { overflowX: 'auto', maxWidth: '100%' },
  panel: { display: 'flex', flexDirection: 'column', gap: cg.space[3], minWidth: 0 },
});

const PAGE_HELP =
  'The Counterfactual Lab answers “what if the investigation had gone differently at this decision?” without hindsight. Choose a decision fork, generate simulated paths, and compare them with what actually happened. A simulation may only use what was on record strictly before the decision; the leak check proves it. Every simulated value is an estimate and is labelled Simulated. A reviewer accepts or rejects a path, and only an accepted path can become a draft SkillDNA. Hindsight, which uses the final resolution, is kept in its own labelled panel.';

function openFork(forkId: string): void {
  writeUrlState({ sel: forkId, step: null, node: null }, 'push');
}

function openScenario(scenarioId: string): void {
  writeUrlState({ sel: scenarioId, step: null, node: null }, 'push');
}

function openStep(stepId: string): void {
  writeUrlState({ step: stepId, tab: 'evidence' }, 'push');
}

function NoPaths({ children }: { children?: string }) {
  return (
    <EmptyState
      compact
      icon={<BeakerRegular />}
      title="No simulated path to show"
      description={children ?? 'Generate simulated paths for this fork with the button above.'}
    />
  );
}

function Lab({
  caseId,
  forks,
  earliestId,
  eventCount,
}: {
  caseId: string;
  forks: readonly DecisionFork[];
  earliestId: string | null;
  eventCount: number | null;
}) {
  const styles = useStyles();
  const scenarios = useScenarioList(caseId);
  const [selection] = useSelectionState();
  const [tab, setTab] = useTabState(TABS, 'compare');
  const [stepParam] = useUrlState('step', STEP_CODEC);
  const list: readonly CounterfactualScenario[] | null = scenarios.data?.items ?? null;
  const { fork, scenario } = resolveSelection(forks, list ?? [], earliestId, selection);
  const forkScenarios = fork && list ? scenariosOfFork(list, fork.id) : [];
  const boundary = scenario?.boundary.asOf ?? fork?.eligibility.boundary ?? null;
  const needsEvidence = tab === 'evidence' || tab === 'decision';
  const evidence = useDecisionTimeEvidence(caseId, needsEvidence ? boundary : null);
  const actions = useRecordedActions(caseId, tab === 'compare' && scenario !== null);
  const evidenceById = useMemo(
    () => (evidence.data ? new Map(evidence.data.evidence.map((item) => [item.id, item])) : null),
    [evidence.data],
  );
  const bearings = useMemo(() => bearingsOf(evidence.data), [evidence.data]);
  const evidenceRead: EvidenceReadState = {
    loading: evidence.isPending,
    error: evidence.isError ? evidence.error : null,
    errorAt: evidence.errorUpdatedAt,
    retrying: evidence.isFetching,
    onRetry: () => void evidence.refetch(),
  };
  const pathsFailedText = scenarios.isError
    ? 'The simulated paths could not be loaded, so there is nothing to show yet. Use Retry above to try again.'
    : undefined;

  if (!fork) return null;

  return (
    <div className={styles.layout}>
      <div className={styles.side}>
        <ForkSelector
          forks={forks}
          earliestId={earliestId}
          selectedId={fork.id}
          scenarios={list}
          onSelect={openFork}
        />
      </div>
      <div className={styles.main}>
        <ForkHeader caseId={caseId} fork={fork} />
        <BoundaryPanel fork={fork} scenario={scenario} caseEventCount={eventCount} />
        {scenarios.isPending ? (
          <LoadingSkeleton variant="text" count={2} label="Loading the simulated paths" />
        ) : scenarios.isError ? (
          <QueryErrorState
            compact
            subject="The simulated paths"
            error={scenarios.error}
            onRetry={() => void scenarios.refetch()}
            retrying={scenarios.isFetching}
          />
        ) : (
          <PathsBar
            caseId={caseId}
            fork={fork}
            scenarios={forkScenarios}
            selectedId={scenario?.id ?? null}
            onSelect={openScenario}
          />
        )}
        <TabList
          className={styles.tabs}
          selectedValue={tab}
          onTabSelect={(_event, data) => setTab(data.value as LabTab)}
          aria-label="Lab sections"
        >
          {TABS.map((value) => (
            <Tab key={value} value={value} id={`lab-tab-${value}`}>
              {TAB_LABELS[value]}
            </Tab>
          ))}
        </TabList>
        <div
          role="tabpanel"
          id={`lab-panel-${tab}`}
          aria-labelledby={`lab-tab-${tab}`}
          className={styles.panel}
        >
          {tab === 'decision' ? (
            <>
              {evidenceRead.error && isRateLimited(evidenceRead.error) ? (
                <AsOfLimited
                  key={evidenceRead.errorAt}
                  error={evidenceRead.error}
                  subject="the evidence these alternatives rest on"
                  compact
                  onRetry={evidenceRead.onRetry}
                  retrying={evidenceRead.retrying}
                />
              ) : null}
              <DecisionMoment fork={fork} caseId={caseId} evidenceById={evidenceById} />
            </>
          ) : scenarios.isPending ? (
            <LoadingSkeleton variant="chart" count={1} label="Loading the simulated paths" />
          ) : (
            <>
              {tab === 'compare' ? (
                scenario ? (
                  actions.isPending ? (
                    <LoadingSkeleton variant="chart" count={1} label="Loading the recorded path" />
                  ) : actions.isError ? (
                    <QueryErrorState
                      compact
                      subject="The recorded path"
                      error={actions.error}
                      onRetry={() => void actions.refetch()}
                      retrying={actions.isFetching}
                    />
                  ) : (
                    <ComparisonPanel fork={fork} scenario={scenario} actions={actions.data.items} />
                  )
                ) : (
                  <NoPaths>{pathsFailedText}</NoPaths>
                )
              ) : null}
              {tab === 'evidence' ? (
                scenario ? (
                  <EvidenceInspector
                    caseId={caseId}
                    scenario={scenario}
                    selectedStepId={stepParam}
                    onSelectStep={(id) => writeUrlState({ step: id }, 'replace')}
                    evidenceById={evidenceById}
                    bearings={bearings}
                    evidenceRead={evidenceRead}
                  />
                ) : (
                  <NoPaths>{pathsFailedText}</NoPaths>
                )
              ) : null}
              {tab === 'graph' ? (
                <GraphPanel
                  caseId={caseId}
                  fork={fork}
                  scenario={scenario}
                  onOpenFork={openFork}
                  onOpenStep={openStep}
                  onOpenScenario={openScenario}
                />
              ) : null}
              {tab === 'review' ? (
                scenario ? (
                  <ReviewPanel caseId={caseId} scenario={scenario} />
                ) : (
                  <NoPaths>
                    {pathsFailedText ?? 'A path has to exist before it can be reviewed.'}
                  </NoPaths>
                )
              ) : null}
            </>
          )}
        </div>
        <HindsightPanel caseId={caseId} fork={fork} scenario={scenario} />
      </div>
    </div>
  );
}

/**
 * Counterfactual Lab (`/cases/[caseId]/counterfactual`): choose a decision fork (the earliest meaningful one is
 * highlighted), see its temporal boundary and leak check, generate and compare simulated paths with what happened,
 * inspect the evidence behind each simulated step, review the path, extract a SkillDNA and read the hindsight check in
 * its own panel. `?sel=` is the fork or scenario, `?tab=` the section, `?step=` the inspected step, `?mode=` and `?node=`
 * the graph view and its selection.
 */
export function CounterfactualLabPage({ caseId }: { caseId: string }) {
  const styles = useStyles();
  const auth = useAuth();
  const caseQuery = useCaseDetail(caseId);
  const forks = useForkList(caseId);
  const detail = caseQuery.data;

  return (
    <>
      <PageHeader
        title="Counterfactual Lab"
        description="Choose a decision fork and see what a safer investigation path would have looked like, using only what was known at that moment."
        help={PAGE_HELP}
        meta={
          <>
            <ProvenanceBadge kind="simulated" />
            <ProvenanceBadge kind="estimated" />
            {detail?.synthetic ? <ProvenanceBadge kind="synthetic" /> : null}
          </>
        }
        actions={
          <div className={styles.actions}>
            <LinkButton
              href={caseHref(caseId, 'hypotheses')}
              appearance="outline"
              icon={<LightbulbRegular />}
            >
              Hypothesis Arena
            </LinkButton>
            <Button
              appearance="outline"
              icon={<ArrowSyncRegular />}
              disabled={auth.status !== 'ready' || forks.isFetching}
              onClick={() => void forks.refetch()}
            >
              {forks.isFetching && !forks.isPending ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>
        }
      />
      <div className={styles.page}>
        {detail ? (
          <p className={styles.context}>
            <strong>{detail.reference}</strong>
            <span>{detail.title}</span>
          </p>
        ) : null}
        <Notice variant="info" compact title="Simulation, not history">
          Everything marked Simulated is an estimate made from what was on record before the
          decision. It is not something that happened.
        </Notice>
        <QueryBoundary
          query={forks}
          subject="The Counterfactual Lab"
          skeleton={<LabSkeleton />}
          isEmpty={(value) => value.items.length === 0}
          empty={
            <EmptyState
              headingLevel={2}
              icon={<BranchForkRegular />}
              title="No decision forks in this case"
              description="CaseGuard found no moment where a clearly better path was available, so there is nothing to simulate. That is a good sign for this case, not an error."
              action={
                <LinkButton
                  href={caseHref(caseId, 'hypotheses')}
                  appearance="primary"
                  icon={<LightbulbRegular />}
                >
                  See the hypotheses
                </LinkButton>
              }
              secondaryAction={
                <LinkButton href={caseHref(caseId, 'timeline')} appearance="outline">
                  Open the timeline
                </LinkButton>
              }
            />
          }
        >
          {(value, meta) => (
            <div
              className={mergeClasses(meta.isRefreshing && styles.busy)}
              aria-busy={meta.isRefreshing}
            >
              <Lab
                caseId={caseId}
                forks={value.items}
                earliestId={value.earliestMeaningfulForkId}
                eventCount={detail?.eventCount ?? null}
              />
            </div>
          )}
        </QueryBoundary>
      </div>
    </>
  );
}
