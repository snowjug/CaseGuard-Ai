'use client';

import { SYNTHETIC_DATA_NOTICE, type CommandCenter } from '@caseguard/schemas';
import {
  EmptyState,
  Notice,
  PageHeader,
  ProvenanceBadge,
  SectionHeader,
  StatusBadge,
  MetricCard,
  formatDateTimeUtc,
  formatTimeUtc,
} from '@caseguard/ui';
import { Button, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { ArrowSyncRegular, FolderRegular } from '@fluentui/react-icons';
import { keepPreviousData } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { CaseSelect } from '../../components/common/CaseSelect';
import { LinkButton } from '../../components/common/LinkButton';
import { QueryBoundary } from '../../components/common/QueryBoundary';
import { useActiveCase } from '../../lib/active-case';
import { useApiQuery } from '../../lib/api/hooks';
import { useAuth } from '../../lib/auth/context';
import { useSession } from '../../lib/auth/session';
import { parseCaseId } from '../../lib/case-cookie';
import { caseHref } from '../../lib/deep-links';
import { ANALYSIS_STATE_BADGES, CASE_STATUS_LABELS, SEVERITY_LABELS } from '../../lib/labels';
import { codecs, useUrlState } from '../../lib/url-state';
import { HypothesisPanel, SkillMatchPanel } from './InsightPanels';
import { MissingEvidencePanel } from './MissingEvidencePanel';
import { RecentCasesPanel } from './RecentCasesPanel';
import { CommandCenterSkeleton } from './Skeleton';
import { SkillCandidatesPanel } from './SkillCandidatesPanel';
import { SystemHealthPanel } from './SystemHealthPanel';
import { WarningsPanel } from './WarningsPanel';
import { cg } from '@caseguard/ui';

const CASE_PARAM = codecs.optionalString();

const useStyles = makeStyles({
  page: { display: 'flex', flexDirection: 'column', gap: cg.space[6], minWidth: 0 },
  busy: { opacity: 0.72 },
  actions: { display: 'flex', alignItems: 'flex-end', flexWrap: 'wrap', gap: cg.space[3] },
  updated: { fontSize: tokens.fontSizeBase200, color: cg.textMuted, alignSelf: 'center' },
  context: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: `${cg.space[2]} ${cg.space[4]}`,
    padding: `${cg.space[3]} ${cg.space[4]}`,
    borderRadius: cg.radius.lg,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surface,
  },
  contextMain: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    flex: '1 1 320px',
    minWidth: 0,
  },
  contextTitle: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
    overflowWrap: 'anywhere',
  },
  contextMeta: { margin: 0, fontSize: tokens.fontSizeBase300, color: cg.textSecondary },
  section: { display: 'flex', flexDirection: 'column', gap: cg.space[3] },
  metrics: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: cg.space[4],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  band: {
    display: 'grid',
    gap: cg.space[4],
    gridTemplateColumns: 'minmax(0, 1fr)',
    alignItems: 'start',
    '@media (min-width: 1100px)': { gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)' },
  },
  bandEven: {
    '@media (min-width: 1100px)': { gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' },
  },
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
});

const PAGE_HELP =
  'The Command Center summarises one case: seven quality metrics (each an estimate shown with its range), the evidence still missing, the leading hypothesis, the best-matching SkillDNA and the warnings to act on first. Every value comes from the analysis of the case; nothing is typed in by hand.';

function CaseContext({ activeCase }: { activeCase: NonNullable<CommandCenter['activeCase']> }) {
  const styles = useStyles();
  const analysis = ANALYSIS_STATE_BADGES[activeCase.analysisState];
  return (
    <div className={styles.context} role="group" aria-label="Active case">
      <div className={styles.contextMain}>
        <p className={styles.contextTitle}>
          {activeCase.reference} · {activeCase.title}
        </p>
        <p className={styles.contextMeta}>
          {activeCase.product} · {activeCase.workload} · {SEVERITY_LABELS[activeCase.severity]} ·{' '}
          {CASE_STATUS_LABELS[activeCase.status]} · opened {formatDateTimeUtc(activeCase.openedAt)}
        </p>
      </div>
      <StatusBadge status={analysis.status} label={analysis.label} />
      {activeCase.synthetic ? <ProvenanceBadge kind="synthetic" /> : null}
      <LinkButton href={caseHref(activeCase.id)} appearance="outline">
        Open case
      </LinkButton>
    </div>
  );
}

function Content({ data, isRefreshing }: { data: CommandCenter; isRefreshing: boolean }) {
  const styles = useStyles();
  const { activeCase } = data;
  const caseId = activeCase?.id ?? null;
  const hasSynthetic =
    Boolean(activeCase?.synthetic) ||
    data.metrics.some((metric) => metric.synthetic) ||
    data.recentCases.some((c) => c.synthetic);

  return (
    <div
      className={mergeClasses(styles.page, isRefreshing && styles.busy)}
      aria-busy={isRefreshing}
    >
      {activeCase ? (
        <CaseContext activeCase={activeCase} />
      ) : (
        <Notice variant="info" title="No case selected">
          Choose a case to see its metrics, warnings and hypotheses. The recent cases, skill
          candidates and system health below do not depend on a case.
        </Notice>
      )}

      {hasSynthetic ? (
        <Notice variant="synthetic" compact>
          {SYNTHETIC_DATA_NOTICE}
        </Notice>
      ) : null}
      {data.notices.map((notice) => (
        <Notice key={notice} variant="info" compact title={null}>
          {notice}
        </Notice>
      ))}

      {activeCase && data.metrics.length > 0 ? (
        <section className={styles.section} aria-labelledby="cc-metrics">
          <SectionHeader
            id="cc-metrics"
            title="Key metrics"
            description="Estimates with their ranges. Select a definition to see how a value is calculated."
          />
          <ul className={styles.metrics}>
            {data.metrics.map((metric) => (
              <li key={metric.key}>
                <MetricCard metric={metric} headingLevel={3} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {activeCase ? (
        <div className={styles.band}>
          <WarningsPanel
            warnings={data.openWarnings}
            generatedAt={data.generatedAt}
            caseId={caseId}
          />
          <div className={styles.stack}>
            <HypothesisPanel hypothesis={data.leadingHypothesis} />
            <SkillMatchPanel match={data.skillMatch} />
          </div>
        </div>
      ) : null}

      {activeCase ? (
        <div className={mergeClasses(styles.band, styles.bandEven)}>
          <MissingEvidencePanel items={data.criticalMissingEvidence} />
          <RecentCasesPanel cases={data.recentCases} />
        </div>
      ) : (
        <RecentCasesPanel cases={data.recentCases} />
      )}

      <div className={mergeClasses(styles.band, styles.bandEven)}>
        <SkillCandidatesPanel skills={data.skillCandidates} />
        <SystemHealthPanel health={data.systemHealth} />
      </div>
    </div>
  );
}

/**
 * Command Center (`/`): the quality picture of the active case. The case comes from `?case=` (shareable), then the
 * last case remembered in the cookie, then the API's default. Loading, empty, error and identity states are handled
 * by `QueryBoundary`; values are rendered exactly as `dashboard.commandCenter` returns them.
 */
export function CommandCenterPage() {
  const styles = useStyles();
  const auth = useAuth();
  const { can } = useSession();
  const { caseId: remembered, setActiveCase } = useActiveCase();
  const [caseParam, setCaseParam] = useUrlState('case', CASE_PARAM);
  // The remembered case only seeds the first request. After that the page follows `?case=` (this page's select and the
  // header switcher both write it), so remembering the API's own default below cannot change the query and refetch.
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
  // header switcher and the case-scoped navigation point at the case the page is showing.
  useEffect(() => {
    if (resolvedCaseId && resolvedCaseId !== remembered) setActiveCase(resolvedCaseId);
  }, [resolvedCaseId, remembered, setActiveCase]);

  const chooseCase = (id: string): void => {
    setActiveCase(id);
    setCaseParam(id);
  };

  return (
    <>
      <PageHeader
        title="Command Center"
        description="Quality, evidence and next steps for the active case, at a glance."
        help={PAGE_HELP}
        actions={
          <div className={styles.actions}>
            <CaseSelect label="Case" value={selected} onChange={chooseCase} />
            <Button
              appearance="outline"
              icon={<ArrowSyncRegular />}
              disabled={auth.status !== 'ready' || query.isFetching}
              onClick={() => void query.refetch()}
            >
              {query.isFetching && !query.isPending ? 'Refreshing…' : 'Refresh'}
            </Button>
            {data ? (
              <span className={styles.updated}>Updated {formatTimeUtc(data.generatedAt)}</span>
            ) : null}
          </div>
        }
      />
      <QueryBoundary
        query={query}
        subject="The Command Center"
        skeleton={<CommandCenterSkeleton />}
        isEmpty={(value) => value.activeCase === null && value.recentCases.length === 0}
        empty={
          <EmptyState
            headingLevel={2}
            icon={<FolderRegular />}
            title="No cases yet"
            description={
              can('case:ingest')
                ? 'Load the synthetic sample from Cases to see CaseGuard analyse an investigation: metrics, evidence, hypotheses and a reusable skill.'
                : 'There are no cases to show. Someone with the Engineer or Administrator role can load the synthetic sample from Cases.'
            }
            action={
              <LinkButton href="/cases" appearance="primary" icon={<FolderRegular />}>
                Open Cases to load the synthetic sample
              </LinkButton>
            }
          />
        }
      >
        {(value, meta) => <Content data={value} isRefreshing={meta.isRefreshing} />}
      </QueryBoundary>
    </>
  );
}
