'use client';

import type { CounterfactualScenario, DecisionFork } from '@caseguard/schemas';
import {
  Accordion,
  Badge,
  BlurFade,
  ButtonLink,
  Card,
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
import {
  ClipboardCheckIcon,
  ClockIcon,
  FileSearchIcon,
  FlaskConicalIcon,
  GitCompareIcon,
  GitForkIcon,
  LightbulbIcon,
  NetworkIcon,
} from 'lucide-react';
import { useMemo } from 'react';
import { AsOfLimited, isRateLimited } from '../../components/case/as-of';
import { CaseNotFoundState } from '../../components/case/CaseNotFoundState';
import { QueryBoundary } from '../../components/common/QueryBoundary';
import { QueryErrorState } from '../../components/common/QueryErrorState';
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
import { ForkSelector } from './ForkSelector';
import { GraphPanel } from './GraphPanel';
import { HindsightPanel } from './HindsightPanel';
import { NoPathsYet, OutcomeHero, OutcomeResult } from './OutcomeHero';
import {
  EligibilityNotice,
  GeneratePathsButton,
  GeneratePathsDialog,
  GenerationProgress,
  StrategyPicker,
  usePathGeneration,
  type PathGeneration,
} from './PathsBar';
import { ReviewPanel } from './ReviewPanel';
import { LabSkeleton } from './Skeleton';
import { useDecisionTimeEvidence, useForkList, useRecordedActions, useScenarioList } from './hooks';
import { bearingsOf, resolveSelection, scenariosOfFork } from './model';

const TABS = ['compare', 'evidence', 'decision', 'graph', 'review'] as const;
type LabTab = (typeof TABS)[number];
const TAB_ITEMS: readonly TabItem[] = [
  { value: 'compare', label: 'Compare', icon: <GitCompareIcon /> },
  { value: 'evidence', label: 'Evidence per step', icon: <FileSearchIcon /> },
  { value: 'decision', label: 'Decision moment', icon: <ClockIcon /> },
  { value: 'graph', label: 'Graph', icon: <NetworkIcon /> },
  { value: 'review', label: 'Review', icon: <ClipboardCheckIcon /> },
];
const STEP_CODEC = codecs.optionalString();

const useStyles = makeStyles({
  page: { display: 'flex', flexDirection: 'column', gap: cg.space[6], minWidth: 0 },
  busy: { opacity: 0.72 },
  strategies: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: `${cg.space[3]} ${cg.space[6]}`,
  },
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[4],
    minWidth: 0,
    paddingTop: cg.space[4],
  },
});

const PAGE_HELP = (
  <>
    <p>
      This page answers “what if the investigation had gone differently at this decision?” without
      hindsight. Pick a key decision, generate simulated paths, and compare them with what actually
      happened.
    </p>
    <p>
      A simulation may only use what was on record strictly before the decision, and the
      no-hindsight check proves it. Every simulated value is an estimate and is labelled Simulated
      or Estimated: none of it happened.
    </p>
    <p>
      A reviewer accepts or rejects a path, and only an accepted path can become a draft skill.
      “Known only later” uses the final resolution, so it is kept apart on purpose.
    </p>
  </>
);

const SIMULATION_NOTE =
  'Everything marked Simulated is an estimate made from what was on record before the decision. It is not something that happened.';

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
      icon={<FlaskConicalIcon />}
      title="No simulated path yet"
      description={children ?? 'Generate paths for this key decision and this view fills in.'}
    />
  );
}

type ScenarioQuery = ReturnType<typeof useScenarioList>;

interface LabProps {
  caseId: string;
  forks: readonly DecisionFork[];
  earliestId: string | null;
  fork: DecisionFork;
  scenario: CounterfactualScenario | null;
  scenarios: ScenarioQuery;
  /** The paths of the chosen key decision, in strategy order. */
  forkScenarios: readonly CounterfactualScenario[];
  generation: PathGeneration;
  eventCount: number | null;
  refreshing: boolean;
  onRefresh: () => void;
}

function Lab({
  caseId,
  forks,
  earliestId,
  fork,
  scenario,
  scenarios,
  forkScenarios,
  generation,
  eventCount,
  refreshing,
  onRefresh,
}: LabProps) {
  const styles = useStyles();
  const [tab, setTab] = useTabState(TABS, 'compare');
  const [stepParam] = useUrlState('step', STEP_CODEC);
  const list: readonly CounterfactualScenario[] | null = scenarios.data?.items ?? null;
  const boundary = scenario?.boundary.asOf ?? fork.eligibility.boundary ?? null;
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

  const answer = scenarios.isPending ? (
    <LoadingSkeleton variant="text" count={3} label="Loading the simulated paths" />
  ) : scenarios.isError ? (
    <QueryErrorState
      compact
      subject="The simulated paths"
      error={scenarios.error}
      onRetry={() => void scenarios.refetch()}
      retrying={scenarios.isFetching}
    />
  ) : scenario ? (
    <OutcomeResult scenario={scenario} />
  ) : (
    <>
      <NoPathsYet>
        {fork.eligibility.eligible
          ? 'Generate paths to see how a safer path would have gone from this decision, using only what was known then.'
          : 'This key decision cannot be simulated, so there is nothing to compare.'}
      </NoPathsYet>
      <EligibilityNotice fork={fork} hasPaths={false} />
    </>
  );

  return (
    <div className={styles.page}>
      <BlurFade index={0}>
        <ForkSelector
          forks={forks}
          earliestId={earliestId}
          selectedId={fork.id}
          scenarios={list}
          onSelect={openFork}
          onRefresh={onRefresh}
          refreshing={refreshing}
        />
      </BlurFade>
      <BlurFade index={1}>
        <OutcomeHero caseId={caseId} fork={fork}>
          {answer}
        </OutcomeHero>
      </BlurFade>
      {scenario && !scenarios.isError ? (
        <BlurFade index={2} className={styles.strategies}>
          <StrategyPicker
            scenarios={forkScenarios}
            selectedId={scenario.id}
            onSelect={openScenario}
          />
          <GeneratePathsButton generation={generation} hasPaths />
        </BlurFade>
      ) : null}
      <GenerationProgress generation={generation} />
      <BlurFade index={3}>
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as LabTab)}
          items={TAB_ITEMS}
          aria-label="What if sections"
        >
          <TabPanel value={tab} className={styles.panel}>
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
                      <LoadingSkeleton
                        variant="chart"
                        count={1}
                        label="Loading the recorded path"
                      />
                    ) : actions.isError ? (
                      <QueryErrorState
                        compact
                        subject="The recorded path"
                        error={actions.error}
                        onRetry={() => void actions.refetch()}
                        retrying={actions.isFetching}
                      />
                    ) : (
                      <ComparisonPanel
                        fork={fork}
                        scenario={scenario}
                        actions={actions.data.items}
                      />
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
          </TabPanel>
        </Tabs>
      </BlurFade>
      <BlurFade index={4}>
        <Card flat padding="sm">
          <Accordion>
            <BoundaryPanel fork={fork} scenario={scenario} caseEventCount={eventCount} />
            <HindsightPanel caseId={caseId} fork={fork} scenario={scenario} />
          </Accordion>
        </Card>
      </BlurFade>
    </div>
  );
}

/**
 * What if (`/cases/[caseId]/counterfactual`): pick a key decision (the earliest meaningful one is marked), read what a safer
 * path would have changed against what happened, then the comparison, the evidence behind each simulated step, the decision
 * moment, the graph and the review of the path, with the no-hindsight check and the hindsight check folded below.
 * `?sel=` is the key decision or path, `?tab=` the section, `?step=` the inspected step, `?mode=` and `?node=` the graph
 * view and its selection. The one primary action, generating paths, exists only while the chosen decision has none.
 */
export function CounterfactualLabPage({ caseId }: { caseId: string }) {
  const styles = useStyles();
  const caseQuery = useCaseDetail(caseId);
  const forks = useForkList(caseId);
  const scenarios = useScenarioList(caseId);
  const [selection] = useSelectionState();
  const detail = caseQuery.data;
  const forkItems = forks.data?.items ?? [];
  const earliestId = forks.data?.earliestMeaningfulForkId ?? null;
  const list: readonly CounterfactualScenario[] | null = scenarios.data?.items ?? null;
  const { fork, scenario } = resolveSelection(forkItems, list ?? [], earliestId, selection);
  const forkScenarios = fork && list ? scenariosOfFork(list, fork.id) : [];
  const generation = usePathGeneration(caseId, fork, forkScenarios);

  // A case that does not exist has nothing to wait for and nothing to retry: say so, instead of failing on each read.
  if (caseQuery.isError && caseQuery.error.isNotFound) return <CaseNotFoundState />;

  return (
    <>
      <PageHeader
        title="What if"
        description="See how a safer path would have gone."
        help={PAGE_HELP}
        meta={
          <>
            <Badge tone="simulated" icon={<FlaskConicalIcon />} dashed title={SIMULATION_NOTE}>
              Simulation, not history
            </Badge>
            {detail?.synthetic ? <ProvenanceBadge kind="synthetic" /> : null}
          </>
        }
        actions={
          fork && list && forkScenarios.length === 0 ? (
            <GeneratePathsButton generation={generation} hasPaths={false} />
          ) : null
        }
      />
      <QueryBoundary
        query={forks}
        subject="The what-if view"
        skeleton={<LabSkeleton />}
        isEmpty={(value) => value.items.length === 0}
        empty={
          <EmptyState
            headingLevel={2}
            icon={<GitForkIcon />}
            title="No key decisions in this case"
            description="CaseGuard found no moment where a clearly better path was available, so there is nothing to simulate. That is a good sign for this case, not an error."
            action={
              <ButtonLink
                href={caseHref(caseId, 'hypotheses')}
                variant="primary"
                icon={<LightbulbIcon />}
              >
                See possible causes
              </ButtonLink>
            }
            secondaryAction={
              <ButtonLink href={caseHref(caseId, 'timeline')} variant="secondary">
                Open the timeline
              </ButtonLink>
            }
          />
        }
      >
        {(value, meta) =>
          fork ? (
            <div
              className={mergeClasses(meta.isRefreshing && styles.busy)}
              aria-busy={meta.isRefreshing}
            >
              <Lab
                caseId={caseId}
                forks={value.items}
                earliestId={value.earliestMeaningfulForkId}
                fork={fork}
                scenario={scenario}
                scenarios={scenarios}
                forkScenarios={forkScenarios}
                generation={generation}
                eventCount={detail?.eventCount ?? null}
                refreshing={meta.isRefreshing}
                onRefresh={() => void forks.refetch()}
              />
            </div>
          ) : null
        }
      </QueryBoundary>
      <GeneratePathsDialog generation={generation} />
    </>
  );
}
