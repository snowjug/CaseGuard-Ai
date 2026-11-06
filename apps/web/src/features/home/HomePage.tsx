'use client';

import type { CommandCenter } from '@caseguard/schemas';
import {
  Accordion,
  AccordionItem,
  Badge,
  BentoGrid,
  BentoItem,
  BlurFade,
  ButtonLink,
  Card,
  IconButton,
  MetricCard,
  PageHeader,
  RelativeTime,
  UiLink,
  cg,
} from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { keepPreviousData } from '@tanstack/react-query';
import { PlusIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CaseSelect } from '../../components/common/CaseSelect';
import { QueryBoundary } from '../../components/common/QueryBoundary';
import { useActiveCase } from '../../lib/active-case';
import { useApiQuery } from '../../lib/api/hooks';
import { useAuth } from '../../lib/auth/context';
import { useSession } from '../../lib/auth/session';
import { parseCaseId } from '../../lib/case-cookie';
import { HEALTH_BADGES } from '../../lib/labels';
import { ADD_CASE_HREF } from '../../lib/nav';
import { codecs, useUrlState } from '../../lib/url-state';
import { FixFirst } from './FixFirst';
import { FlowSteps, type FlowStage } from '../../components/common/FlowSteps';
import { HomeSkeleton } from './HomeSkeleton';
import { RecentCases, SkillsToReuse } from './HomeLists';
import { KeyNumbers } from './KeyNumbers';
import { LatestReview } from './LatestReview';
import { NoCases } from './NoCases';

const CASE_PARAM = codecs.optionalString();

const useStyles = makeStyles({
  page: { display: 'flex', flexDirection: 'column', gap: cg.space[6], minWidth: 0 },
  busy: { opacity: 0.72 },
  fill: { height: '100%' },
  updated: { fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  notes: {
    margin: 0,
    paddingInlineStart: cg.space[4],
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
  },
  metricList: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: cg.space[4],
    margin: 0,
    padding: 0,
    listStyleType: 'none',
  },
  choose: { display: 'flex', flexDirection: 'column', gap: cg.space[3] },
  chooseTitle: {
    margin: 0,
    fontSize: tokens.fontSizeBase500,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
  },
  chooseText: { margin: 0, color: cg.textSecondary, fontSize: tokens.fontSizeBase300 },
});

const PAGE_HELP =
  'Home shows the latest review: how the case went, what to fix first and a few key numbers. Every value comes from the analysis of the case, and the numbers are estimates with their ranges.';

/** Where the person is in the flow: add a case, see the review, fix what matters. */
function stageOf(data: CommandCenter): FlowStage {
  const active = data.activeCase;
  if (!active) return data.recentCases.length === 0 ? 1 : 2;
  if (active.analysisState !== 'analyzed') return 2;
  const open =
    data.openWarnings.length +
    data.criticalMissingEvidence.filter((item) => item.resolvedAt === null).length;
  return open > 0 ? 3 : 4;
}

interface ContentProps {
  data: CommandCenter;
  isRefreshing: boolean;
  selectedId: string | null;
  onChooseCase: (caseId: string) => void;
}

function Content({ data, isRefreshing, selectedId, onChooseCase }: ContentProps) {
  const styles = useStyles();
  const { activeCase } = data;
  const analysed = activeCase?.analysisState === 'analyzed';
  const quality = data.metrics.find((metric) => metric.key === 'case_quality_index');

  return (
    <div
      className={mergeClasses(styles.page, isRefreshing && styles.busy)}
      aria-busy={isRefreshing}
    >
      <BlurFade index={0}>
        <FlowSteps stage={stageOf(data)} />
      </BlurFade>
      <BentoGrid>
        <BentoItem span={12} spanLg={activeCase && analysed ? 7 : 12}>
          <BlurFade index={1} className={styles.fill}>
            {activeCase ? (
              <LatestReview
                activeCase={activeCase}
                quality={quality}
                warnings={data.openWarnings}
                hypothesis={data.leadingHypothesis}
                selectedId={selectedId}
                onChooseCase={onChooseCase}
              />
            ) : (
              <Card
                as="section"
                padding="lg"
                className={styles.choose}
                aria-labelledby="home-choose"
              >
                <h2 id="home-choose" className={styles.chooseTitle}>
                  Choose a case
                </h2>
                <p className={styles.chooseText}>
                  Pick one to see its review, or open one of the recent cases below.
                </p>
                <CaseSelect label="Case" value={selectedId} onChange={onChooseCase} />
              </Card>
            )}
          </BlurFade>
        </BentoItem>
        {activeCase && analysed ? (
          <BentoItem span={12} spanLg={5}>
            <BlurFade index={2} className={styles.fill}>
              <FixFirst
                warnings={data.openWarnings}
                missing={data.criticalMissingEvidence}
                caseId={activeCase.id}
                skillMatch={data.skillMatch}
                hasLessons={quality?.status === 'poor' || quality?.status === 'watch'}
              />
            </BlurFade>
          </BentoItem>
        ) : null}
        {activeCase && analysed ? <KeyNumbers metrics={data.metrics} /> : null}
        <BentoItem span={12} spanLg={6}>
          <BlurFade index={4} className={styles.fill}>
            <RecentCases cases={data.recentCases} />
          </BlurFade>
        </BentoItem>
        <BentoItem span={12} spanLg={6}>
          <BlurFade index={5} className={styles.fill}>
            <SkillsToReuse
              match={activeCase ? data.skillMatch : null}
              candidates={data.skillCandidates}
            />
          </BlurFade>
        </BentoItem>
      </BentoGrid>
      {activeCase && analysed && data.metrics.length > 0 ? (
        <Accordion>
          <AccordionItem
            headingLevel={2}
            title="All metrics"
            subtitle={`${data.metrics.length} estimates, each with its range`}
          >
            <ul className={styles.metricList}>
              {data.metrics.map((metric) => (
                <li key={metric.key}>
                  <MetricCard metric={metric} headingLevel={3} />
                </li>
              ))}
            </ul>
          </AccordionItem>
          {data.notices.length > 0 ? (
            <AccordionItem headingLevel={2} title="How to read these numbers">
              <ul className={styles.notes}>
                {data.notices.map((notice) => (
                  <li key={notice}>{notice}</li>
                ))}
              </ul>
            </AccordionItem>
          ) : null}
        </Accordion>
      ) : null}
    </div>
  );
}

/**
 * Home (`/`): the latest review at a glance. The case comes from `?case=` (shareable), then the last case remembered in
 * the cookie, then the API's default. Loading, empty, error and identity states are handled by `QueryBoundary`; values
 * are rendered exactly as `dashboard.commandCenter` returns them.
 */
export function HomePage() {
  const auth = useAuth();
  const { can } = useSession();
  const styles = useStyles();
  const { caseId: remembered, setActiveCase } = useActiveCase();
  const [caseParam, setCaseParam] = useUrlState('case', CASE_PARAM);
  // The remembered case only seeds the first request. After that the page follows `?case=` (its select writes it), so
  // remembering the API's own default below cannot change the query and refetch.
  const [seed] = useState(remembered);
  const requested = parseCaseId(caseParam) ?? seed;
  const query = useApiQuery(
    'dashboard.commandCenter',
    { query: requested ? { caseId: requested } : {} },
    { enabled: auth.status === 'ready', placeholderData: keepPreviousData },
  );
  const data = query.data;
  const selected = data?.activeCase?.id ?? requested;
  const resolvedCaseId = query.isPlaceholderData ? undefined : data?.activeCase?.id;

  // When the API chose the case (nothing was remembered, or the remembered one is gone), remember its choice so the
  // palette and the "continue" shortcuts point at the case the page is showing.
  useEffect(() => {
    if (resolvedCaseId && resolvedCaseId !== remembered) setActiveCase(resolvedCaseId);
  }, [resolvedCaseId, remembered, setActiveCase]);

  const chooseCase = (id: string): void => {
    setActiveCase(id);
    setCaseParam(id);
  };

  const hasCases = data ? data.activeCase !== null || data.recentCases.length > 0 : false;
  const health =
    data && data.systemHealth.status !== 'healthy' ? HEALTH_BADGES[data.systemHealth.status] : null;

  return (
    <>
      <PageHeader
        title="Home"
        description="What needs attention, and where to start."
        help={PAGE_HELP}
        meta={
          <>
            {data ? (
              <span className={styles.updated}>
                Updated <RelativeTime value={data.generatedAt} />
              </span>
            ) : null}
            {health ? (
              <UiLink href="/system">
                <Badge tone="uncertain" icon={<TriangleAlertIcon />} size="sm">
                  System status: {health.label.toLowerCase()}
                </Badge>
              </UiLink>
            ) : null}
          </>
        }
        actions={
          <>
            {auth.status === 'ready' ? (
              <IconButton
                icon={<RefreshCwIcon />}
                label="Refresh"
                disabled={query.isFetching}
                onClick={() => void query.refetch()}
              />
            ) : null}
            {hasCases && can('case:ingest') ? (
              <ButtonLink href={ADD_CASE_HREF} variant="primary" icon={<PlusIcon />}>
                Add a case
              </ButtonLink>
            ) : null}
          </>
        }
      />
      <QueryBoundary
        query={query}
        subject="Home"
        skeleton={<HomeSkeleton />}
        isEmpty={(value) => value.activeCase === null && value.recentCases.length === 0}
        empty={<NoCases canAdd={can('case:ingest')} />}
      >
        {(value, meta) => (
          <Content
            data={value}
            isRefreshing={meta.isRefreshing}
            selectedId={selected ?? null}
            onChooseCase={chooseCase}
          />
        )}
      </QueryBoundary>
    </>
  );
}
