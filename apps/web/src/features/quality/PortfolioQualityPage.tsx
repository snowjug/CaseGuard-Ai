'use client';

import type { AnalyticsOverview } from '@caseguard/schemas';
import {
  BentoGrid,
  BentoItem,
  BlurFade,
  Button,
  ButtonLink,
  EmptyState,
  Field,
  PageHeader,
  ProvenanceBadge,
  RelativeTime,
  Select,
  VisuallyHidden,
  cg,
} from '@caseguard/ui';
import { makeStyles, mergeClasses } from '@fluentui/react-components';
import { keepPreviousData } from '@tanstack/react-query';
import { ArrowRightIcon, ChartColumnIcon, RefreshCwIcon } from 'lucide-react';
import { useState } from 'react';
import { PermissionGate } from '../../components/common/PermissionGate';
import { PermissionNeeded } from '../../components/common/PermissionNeeded';
import { QueryBoundary } from '../../components/common/QueryBoundary';
import { useActiveCase } from '../../lib/active-case';
import { useApiQuery } from '../../lib/api/hooks';
import { useAuth } from '../../lib/auth/context';
import { useSession } from '../../lib/auth/session';
import { caseHref } from '../../lib/deep-links';
import { useLook } from './look';
import { KeyFigures, TrendCard } from './PortfolioHero';
import {
  AssumptionsPanel,
  EffortPatternsPanel,
  ForkCategoriesPanel,
  MissingEvidencePanel,
} from './PortfolioPanels';
import {
  AcceptancePanel,
  DisagreementPanel,
  PrivacyPanel,
  SkillsPanel,
  TokenPanel,
} from './PortfolioSkillPanels';
import { PortfolioSkeleton } from './PortfolioSkeleton';

const useStyles = makeStyles({
  launcher: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    gap: cg.space[2],
    maxWidth: '100%',
  },
  field: { flex: '0 1 320px', width: '320px', maxWidth: '100%', minWidth: 0 },
  fill: { height: '100%', boxSizing: 'border-box' },
});

const PAGE_HELP = (
  <>
    <p>
      This page shows what the analysed cases say about quality, evidence and skills: how scores
      move over time, where a better step was available and where effort could be saved.
    </p>
    <p>
      Everything here is an aggregate and an estimate. No figure ranks, scores or identifies an
      individual employee, and with few cases every trend is illustrative only. Choose a case to see
      how its own score was built.
    </p>
  </>
);

/**
 * Picks an analysed case and links to its score. A real link, so choosing never moves the page on its own. It works for
 * everyone who can read a case's quality, whether or not the portfolio figures are theirs.
 */
function CaseLauncher() {
  const styles = useStyles();
  const auth = useAuth();
  const { can } = useSession();
  const { caseId: active } = useActiveCase();
  const cases = useApiQuery(
    'cases.list',
    { query: { limit: 100 } },
    { enabled: auth.status === 'ready', staleTime: 30_000 },
  );
  const [chosen, setChosen] = useState<string | null>(null);
  if (!can('analytics:read') && !can('quality:read')) return null;
  const analysed = (cases.data?.items ?? []).filter((item) => item.analysisState === 'analyzed');
  const value =
    chosen && analysed.some((item) => item.id === chosen)
      ? chosen
      : analysed.some((item) => item.id === active)
        ? active
        : (analysed[0]?.id ?? null);
  const chosenCase = analysed.find((item) => item.id === value);
  return (
    <div className={styles.launcher}>
      <Field label="Choose a case" className={styles.field}>
        <Select
          value={value ?? ''}
          disabled={analysed.length === 0}
          onChange={(event) => setChosen(event.target.value || null)}
        >
          {analysed.length === 0 ? <option value="">No analysed case</option> : null}
          {analysed.map((item) => (
            <option key={item.id} value={item.id}>
              {item.reference} · {item.title}
            </option>
          ))}
        </Select>
      </Field>
      <ButtonLink
        href={chosenCase ? caseHref(chosenCase.id, 'quality') : '/cases'}
        variant="secondary"
        icon={<ArrowRightIcon />}
        iconPosition="end"
      >
        {chosenCase ? (
          <>
            Open score <VisuallyHidden>of {chosenCase.reference}</VisuallyHidden>
          </>
        ) : (
          'Browse cases'
        )}
      </ButtonLink>
    </div>
  );
}

function Overview({ data, refreshing }: { data: AnalyticsOverview; refreshing: boolean }) {
  const styles = useStyles();
  const look = useLook();
  return (
    <div className={mergeClasses(look.page, refreshing && look.busy)} aria-busy={refreshing}>
      <BentoGrid>
        <BentoItem span={12} spanLg={4}>
          <KeyFigures data={data} />
        </BentoItem>
        <BentoItem span={12} spanLg={8}>
          <BlurFade index={1} className={styles.fill}>
            <TrendCard trend={data.qualityTrend} />
          </BlurFade>
        </BentoItem>
        <BentoItem span={12} spanLg={6}>
          <BlurFade index={2} className={styles.fill}>
            <ForkCategoriesPanel categories={data.forkCategories} />
          </BlurFade>
        </BentoItem>
        <BentoItem span={12} spanLg={6}>
          <BlurFade index={2} className={styles.fill}>
            <MissingEvidencePanel items={data.missingEvidence} />
          </BlurFade>
        </BentoItem>
        <BentoItem span={12} spanLg={7}>
          <BlurFade index={3} className={styles.fill}>
            <EffortPatternsPanel patterns={data.avoidableEffortPatterns} />
          </BlurFade>
        </BentoItem>
        <BentoItem span={12} spanLg={5}>
          <BlurFade index={3} className={styles.fill}>
            <SkillsPanel adoption={data.skillAdoption} effectiveness={data.skillEffectiveness} />
          </BlurFade>
        </BentoItem>
        <BentoItem span={12} spanSm={6} spanLg={4}>
          <BlurFade index={4} className={styles.fill}>
            <TokenPanel tokens={data.tokenEfficiency} />
          </BlurFade>
        </BentoItem>
        <BentoItem span={12} spanSm={6} spanLg={4}>
          <BlurFade index={4} className={styles.fill}>
            <AcceptancePanel acceptance={data.counterfactualAcceptance} />
          </BlurFade>
        </BentoItem>
        <BentoItem span={12} spanLg={4}>
          <BlurFade index={4} className={styles.fill}>
            <DisagreementPanel disagreement={data.reviewerDisagreement} />
          </BlurFade>
        </BentoItem>
        <BentoItem span={12} spanLg={6}>
          <BlurFade index={5} className={styles.fill}>
            <AssumptionsPanel items={data.frequentUnsupportedAssumptions} />
          </BlurFade>
        </BentoItem>
        <BentoItem span={12} spanLg={6}>
          <BlurFade index={5} className={styles.fill}>
            <PrivacyPanel notes={data.privacyNotes} responsibleUse={data.responsibleUseNotice} />
          </BlurFade>
        </BentoItem>
      </BentoGrid>
    </div>
  );
}

function PortfolioContent({
  query,
  allowed,
}: {
  query: ReturnType<typeof useAnalytics>;
  allowed: boolean;
}) {
  if (!allowed) {
    return (
      <PermissionNeeded
        subject="quality trends across all cases"
        permission="analytics:read"
        grantedTo="Managers and administrators"
      />
    );
  }
  return (
    <QueryBoundary
      query={query}
      subject="The quality trends"
      skeleton={<PortfolioSkeleton />}
      isEmpty={(value) => value.cohort.analyzedCaseCount === 0}
      empty={
        <EmptyState
          headingLevel={2}
          icon={<ChartColumnIcon />}
          title="No analysed cases yet"
          description="Quality trends appear after cases have been analysed. Add a case, or try a sample case, and the analysis fills this page."
          action={
            <ButtonLink href="/cases/new" variant="primary">
              Add a case
            </ButtonLink>
          }
          secondaryAction={
            <ButtonLink href="/cases/new?mode=sample" variant="secondary">
              Try a sample case
            </ButtonLink>
          }
        />
      }
    >
      {(data, meta) => <Overview data={data} refreshing={meta.isRefreshing} />}
    </QueryBoundary>
  );
}

/** The portfolio read: only for roles that may see analytics, kept on screen while it refreshes. */
function useAnalytics(enabled: boolean) {
  return useApiQuery('analytics.overview', undefined, {
    enabled,
    placeholderData: keepPreviousData,
  });
}

/**
 * Quality, portfolio level (`/quality`): privacy-safe analytics over the analysed cases (`analytics.overview`). The
 * hero is three figures (cases analysed, average score, time that could have been saved) beside quality over time; the
 * panels below (key decisions, evidence gaps, effort that could be saved, skills in use, usage, accepted better paths,
 * reviewer corrections) fold their tables away. The sample-size note and the responsible-use notice always show; nothing
 * ranks people. Roles that can read case quality but not analytics (engineers, reviewers) still get the way into a
 * single case's score, and are told why the portfolio is not theirs.
 */
export function PortfolioQualityPage() {
  const look = useLook();
  const auth = useAuth();
  const { can } = useSession();
  const allowed = can('analytics:read');
  const query = useAnalytics(auth.status === 'ready' && allowed);
  const refreshing = query.isFetching && !query.isPending;
  return (
    <>
      <PageHeader
        title="Quality"
        description="See quality trends across all cases."
        help={PAGE_HELP}
        meta={
          allowed ? (
            <>
              <ProvenanceBadge kind="estimated" />
              {query.data ? (
                <span className={look.meta}>
                  Updated <RelativeTime value={query.data.generatedAt} />
                </span>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                icon={<RefreshCwIcon />}
                disabled={auth.status !== 'ready' || query.isFetching}
                loading={refreshing}
                onClick={() => void query.refetch()}
              >
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </Button>
            </>
          ) : undefined
        }
        actions={<CaseLauncher />}
      />
      <PermissionGate
        permission={['analytics:read', 'quality:read']}
        subject="quality trends"
        grantedTo="Engineers, reviewers, managers and administrators"
        skeleton={<PortfolioSkeleton />}
      >
        <PortfolioContent query={query} allowed={allowed} />
      </PermissionGate>
    </>
  );
}
