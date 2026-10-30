'use client';

import type { AnalyticsOverview } from '@caseguard/schemas';
import {
  EmptyState,
  Notice,
  PageHeader,
  Panel,
  ProvenanceBadge,
  formatTimeUtc,
} from '@caseguard/ui';
import { Button, Field, Select, mergeClasses } from '@fluentui/react-components';
import { ArrowSyncRegular, FolderRegular } from '@fluentui/react-icons';
import { keepPreviousData } from '@tanstack/react-query';
import { useState } from 'react';
import { LinkButton } from '../../components/common/LinkButton';
import { PermissionGate } from '../../components/common/PermissionGate';
import { PermissionNeeded } from '../../components/common/PermissionNeeded';
import { QueryBoundary } from '../../components/common/QueryBoundary';
import { useActiveCase } from '../../lib/active-case';
import { useApiQuery } from '../../lib/api/hooks';
import { useAuth } from '../../lib/auth/context';
import { useSession } from '../../lib/auth/session';
import { caseHref } from '../../lib/deep-links';
import { formatNumber } from '../../lib/format';
import {
  AssumptionsPanel,
  EffortPatternsPanel,
  ForkCategoriesPanel,
  MissingEvidencePanel,
  TrendPanel,
} from './PortfolioPanels';
import {
  AcceptancePanel,
  DisagreementPanel,
  PrivacyPanel,
  SkillsPanel,
  TokenPanel,
} from './PortfolioSkillPanels';
import { PortfolioSkeleton } from './PortfolioSkeleton';
import { isSmallSample } from './portfolio-model';
import { useInsightStyles } from './styles';

const PAGE_HELP = (
  <>
    <p>
      Quality Review has two levels. This page is the portfolio: what the analysed cases show about
      processes, evidence gaps, skills and effort. Choose a case to review its own quality index,
      warnings and coaching.
    </p>
    <p>
      Everything here is an aggregate and an estimate. No figure ranks, scores or identifies an
      individual employee, and with few cases every trend is illustrative only.
    </p>
  </>
);

/** Picks an analysed case and links to its review. A real link, so choosing never moves the page on its own. */
function CaseReviewLauncher() {
  const styles = useInsightStyles();
  const auth = useAuth();
  const { caseId: active } = useActiveCase();
  const cases = useApiQuery(
    'cases.list',
    { query: { limit: 100 } },
    { enabled: auth.status === 'ready', staleTime: 30_000 },
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const analysed = (cases.data?.items ?? []).filter((item) => item.analysisState === 'analyzed');
  const value =
    chosen && analysed.some((item) => item.id === chosen)
      ? chosen
      : analysed.some((item) => item.id === active)
        ? active
        : (analysed[0]?.id ?? null);
  const chosenCase = analysed.find((item) => item.id === value);
  return (
    <div className={styles.actions}>
      <Field label="Review a case">
        <Select
          className={styles.select}
          value={value ?? ''}
          disabled={analysed.length === 0}
          onChange={(_event, next) => setChosen(next.value || null)}
        >
          {analysed.length === 0 ? <option value="">No analysed case</option> : null}
          {analysed.map((item) => (
            <option key={item.id} value={item.id}>
              {item.reference} · {item.title}
            </option>
          ))}
        </Select>
      </Field>
      <LinkButton
        href={chosenCase ? caseHref(chosenCase.id, 'quality') : '/cases'}
        appearance="primary"
      >
        {chosenCase ? `Open the review of ${chosenCase.reference}` : 'Open Cases'}
      </LinkButton>
    </div>
  );
}

function CohortPanel({ cohort }: { cohort: AnalyticsOverview['cohort'] }) {
  const styles = useInsightStyles();
  const count = (value: number): string => formatNumber(value, { maximumFractionDigits: 0 });
  return (
    <Panel
      title="Cohort"
      description="The cases these analytics cover."
      help="Only analysed cases contribute. The note says how far to trust the aggregates: with fewer than ten analysed cases every average and trend is illustrative only."
    >
      <ul className={styles.tiles} aria-label="Cohort size">
        <li className={styles.tile}>
          <p className={styles.tileLabel}>Cases</p>
          <p className={styles.tileValue}>{count(cohort.caseCount)}</p>
        </li>
        <li className={styles.tile}>
          <p className={styles.tileLabel}>Analysed</p>
          <p className={styles.tileValue}>{count(cohort.analyzedCaseCount)}</p>
        </li>
        <li className={styles.tile}>
          <p className={styles.tileLabel}>Synthetic</p>
          <p className={styles.tileValue}>{count(cohort.syntheticCaseCount)}</p>
        </li>
      </ul>
      <Notice
        variant={isSmallSample(cohort) ? 'warning' : 'info'}
        compact
        title={isSmallSample(cohort) ? 'Small sample' : 'Sample size'}
      >
        {cohort.note}
      </Notice>
    </Panel>
  );
}

function Overview({ data, refreshing }: { data: AnalyticsOverview; refreshing: boolean }) {
  const styles = useInsightStyles();
  return (
    <div className={mergeClasses(styles.page, refreshing && styles.busy)} aria-busy={refreshing}>
      <Notice variant="info" compact title="Responsible use">
        {data.responsibleUseNotice}
      </Notice>
      <CohortPanel cohort={data.cohort} />
      <div className={styles.band}>
        <TrendPanel trend={data.qualityTrend} />
        <ForkCategoriesPanel categories={data.forkCategories} />
      </div>
      <div className={styles.band}>
        <MissingEvidencePanel items={data.missingEvidence} />
        <EffortPatternsPanel patterns={data.avoidableEffortPatterns} />
      </div>
      <div className={styles.bandWide}>
        <SkillsPanel adoption={data.skillAdoption} effectiveness={data.skillEffectiveness} />
        <div className={styles.stack}>
          <TokenPanel tokens={data.tokenEfficiency} />
          <AcceptancePanel acceptance={data.counterfactualAcceptance} />
          <DisagreementPanel disagreement={data.reviewerDisagreement} />
        </div>
      </div>
      <div className={styles.band}>
        <AssumptionsPanel items={data.frequentUnsupportedAssumptions} />
        <PrivacyPanel notes={data.privacyNotes} />
      </div>
    </div>
  );
}

function PortfolioContent() {
  const styles = useInsightStyles();
  const auth = useAuth();
  const { can } = useSession();
  const allowed = can('analytics:read');
  const query = useApiQuery('analytics.overview', undefined, {
    enabled: auth.status === 'ready' && allowed,
    placeholderData: keepPreviousData,
  });
  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <CaseReviewLauncher />
        {allowed ? (
          <Button
            appearance="outline"
            icon={<ArrowSyncRegular />}
            disabled={auth.status !== 'ready' || query.isFetching}
            onClick={() => void query.refetch()}
          >
            {query.isFetching && !query.isPending ? 'Refreshing…' : 'Refresh'}
          </Button>
        ) : null}
        {query.data ? (
          <span className={styles.meta}>Updated {formatTimeUtc(query.data.generatedAt)}</span>
        ) : null}
      </div>
      {!allowed ? (
        <PermissionNeeded
          subject="portfolio analytics"
          permission="analytics:read"
          grantedTo="Managers and administrators"
        />
      ) : (
        <QueryBoundary
          query={query}
          subject="The portfolio analytics"
          skeleton={<PortfolioSkeleton />}
          isEmpty={(value) => value.cohort.analyzedCaseCount === 0}
          empty={
            <EmptyState
              headingLevel={2}
              icon={<FolderRegular />}
              title="No analysed cases yet"
              description="Portfolio analytics summarise cases after they have been analysed. Ingest a case, or use a built-in synthetic sample, and the analysis fills this page."
              action={
                <LinkButton href="/cases" appearance="primary" icon={<FolderRegular />}>
                  Open Cases
                </LinkButton>
              }
            />
          }
        >
          {(data, meta) => <Overview data={data} refreshing={meta.isRefreshing} />}
        </QueryBoundary>
      )}
    </div>
  );
}

/**
 * Quality Review, portfolio level (`/quality`): privacy-safe analytics over the analysed cases (`analytics.overview`):
 * quality over time, decision-fork categories, evidence gaps, avoidable-effort patterns, SkillDNA adoption and
 * effectiveness, token efficiency, counterfactual acceptance and reviewer corrections. The cohort note and the
 * responsible-use notice always show; nothing ranks people. Roles that can read case quality but not analytics
 * (engineers, reviewers) still get the way into a single case's review, and are told why the portfolio is not theirs.
 */
export function PortfolioQualityPage() {
  return (
    <>
      <PageHeader
        title="Quality Review"
        description="Portfolio analytics: what the analysed cases show about processes, evidence and skills."
        help={PAGE_HELP}
        meta={<ProvenanceBadge kind="estimated" />}
      />
      <PermissionGate
        permission={['analytics:read', 'quality:read']}
        subject="Quality Review"
        grantedTo="Engineers, reviewers, managers and administrators"
        skeleton={<PortfolioSkeleton />}
      >
        <PortfolioContent />
      </PermissionGate>
    </>
  );
}
