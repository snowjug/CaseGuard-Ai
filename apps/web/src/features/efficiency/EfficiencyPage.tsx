'use client';

import type { EfficiencyOverview } from '@caseguard/schemas';
import {
  AccordionItem,
  BlurFade,
  Button,
  Field,
  PageHeader,
  Select,
  formatNumber,
  formatPercent,
} from '@caseguard/ui';
import { keepPreviousData } from '@tanstack/react-query';
import {
  ChartNoAxesColumnIcon,
  GaugeIcon,
  InfoIcon,
  ListIcon,
  PiggyBankIcon,
  RefreshCwIcon,
  ScaleIcon,
  ShieldCheckIcon,
} from 'lucide-react';
import { PermissionGate } from '../../components/common/PermissionGate';
import { QueryBoundary } from '../../components/common/QueryBoundary';
import { useApiQuery } from '../../lib/api/hooks';
import { useAuth } from '../../lib/auth/context';
import { useSession } from '../../lib/auth/session';
import { shortId } from '../../lib/format';
import { DetailSections, StateBadge, ViewSkeleton } from '../../lib/advanced-view-parts';
import { codecs, useUrlState } from '../../lib/url-state';
import { AgentsSection } from './AgentsSection';
import { BudgetsSection } from './BudgetsSection';
import { AGENT_CODEC, ExecutionsSection } from './ExecutionsSection';
import { budgetState, tokensText } from './model';
import { PathComparisonSection } from './PathComparisonSection';
import { SafetyLimitsSection } from './SafetyLimitsSection';
import { SavingsSection } from './SavingsSection';
import { useUsageStyles } from './styles';
import { UsageSummary } from './UsageSummary';

const CASE_CODEC = codecs.optionalString();

const SKELETON = <ViewSkeleton label="Loading usage and cost" sections={6} />;

const PAGE_HELP = (
  <>
    <p>
      Usage and cost shows how much model work the analysis used (tokens, time and calls), what was
      saved by sending less or reusing answers, and which limits apply.
    </p>
    <p>
      Every figure is an estimate. With the deterministic offline provider the token counts and
      latencies are simulated and say so; no model usage from Azure OpenAI is shown unless that
      provider is configured and was actually used. Cost stays unknown until unit prices are
      configured.
    </p>
    <p>
      Limits that are not configured read “No limit set”, never zero. Use the scope to look at one
      case; the real-versus-simulated comparison compares tokens, not people.
    </p>
  </>
);

/** Which case the figures are about. It sits above the summary so it is there while the figures load or fail. */
function ScopeBar({
  caseId,
  onChange,
}: {
  caseId: string | null;
  onChange: (caseId: string | null) => void;
}) {
  const styles = useUsageStyles();
  const auth = useAuth();
  const cases = useApiQuery(
    'cases.list',
    { query: { limit: 100 } },
    { enabled: auth.status === 'ready', staleTime: 30_000 },
  );
  const items = cases.data?.items ?? [];
  return (
    <div className={styles.toolbar}>
      <Field label="Scope" className={styles.scope}>
        <Select
          wrapperClassName={styles.scopeSelect}
          value={caseId ?? ''}
          onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
        >
          <option value="">All cases</option>
          {caseId && !items.some((item) => item.id === caseId) ? (
            <option value={caseId}>{caseId}</option>
          ) : null}
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.reference} · {item.title}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}

function EfficiencyContent({
  overview,
  caseId,
  isRefreshing,
}: {
  overview: EfficiencyOverview;
  caseId: string | null;
  isRefreshing: boolean;
}) {
  const styles = useUsageStyles();
  const auth = useAuth();
  const [agent] = useUrlState('agent', AGENT_CODEC);
  const cases = useApiQuery(
    'cases.list',
    { query: { limit: 100 } },
    { enabled: auth.status === 'ready', staleTime: 30_000 },
  );
  const reference = cases.data?.items.find((item) => item.id === caseId)?.reference ?? null;
  const hasUsage = overview.totals.executions > 0;
  const budget = budgetState(overview.budgets);
  const tripped = overview.circuitBreakers.filter((breaker) => breaker.state !== 'closed').length;
  const { savings, caseProcess, byAgent, byModel, totals } = overview;

  return (
    <div className={styles.page} aria-busy={isRefreshing}>
      <BlurFade index={0}>
        <UsageSummary
          overview={overview}
          scope={caseId ? (reference ?? shortId(caseId, 14)) : null}
          busy={isRefreshing}
        />
      </BlurFade>
      <BlurFade index={1}>
        <DetailSections>
          {hasUsage ? (
            <AccordionItem
              headingLevel={2}
              icon={<PiggyBankIcon />}
              title="Estimated savings"
              subtitle={`${tokensText(savings.totalTokens)} tokens saved, by estimate`}
              defaultOpen
            >
              <SavingsSection savings={savings} />
            </AccordionItem>
          ) : null}
          {hasUsage ? (
            <AccordionItem
              headingLevel={2}
              icon={<ScaleIcon />}
              title="Real process versus a simulated better path"
              subtitle={
                caseProcess.counterfactualTokens === null
                  ? 'No comparison is available yet'
                  : caseProcess.estimatedSavingsPct === null
                    ? 'Estimated saving not available'
                    : `Estimated saving ${formatPercent(caseProcess.estimatedSavingsPct, 1)}`
              }
            >
              <PathComparisonSection caseProcess={caseProcess} caseReference={reference} />
            </AccordionItem>
          ) : null}
          <AccordionItem
            headingLevel={2}
            icon={<GaugeIcon />}
            title="Budgets and limits"
            subtitle={budget.label}
            defaultOpen={!hasUsage}
          >
            <BudgetsSection budgets={overview.budgets} />
          </AccordionItem>
          <AccordionItem
            headingLevel={2}
            icon={<ShieldCheckIcon />}
            title="Safety limits"
            subtitle={
              overview.circuitBreakers.length === 0
                ? 'None in use'
                : `${formatNumber(overview.circuitBreakers.length)} in use`
            }
            badge={
              tripped > 0 ? (
                <StateBadge
                  status="uncertain"
                  label={`${formatNumber(tripped)} not normal`}
                  title="A safety limit that has tripped or is checking again."
                />
              ) : undefined
            }
          >
            <SafetyLimitsSection
              breakers={overview.circuitBreakers}
              simulated={overview.labels.simulated}
            />
          </AccordionItem>
          {hasUsage ? (
            <AccordionItem
              headingLevel={2}
              icon={<ChartNoAxesColumnIcon />}
              title="Usage by analysis step and model"
              subtitle={`${formatNumber(byAgent.length)} ${byAgent.length === 1 ? 'step' : 'steps'} · ${formatNumber(byModel.length)} ${byModel.length === 1 ? 'model' : 'models'}`}
            >
              <AgentsSection byAgent={byAgent} byModel={byModel} />
            </AccordionItem>
          ) : null}
          {hasUsage ? (
            <AccordionItem
              headingLevel={2}
              icon={<ListIcon />}
              title="Model calls"
              subtitle={`${formatNumber(totals.executions)} recorded`}
              defaultOpen={agent !== 'all'}
            >
              <ExecutionsSection caseId={caseId} />
            </AccordionItem>
          ) : null}
          {overview.notes.length > 0 ? (
            <AccordionItem
              headingLevel={2}
              icon={<InfoIcon />}
              title="How to read these figures"
              subtitle="What is estimated, what is simulated"
            >
              <ul className={styles.bullets}>
                {overview.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </AccordionItem>
          ) : null}
        </DetailSections>
      </BlurFade>
    </div>
  );
}

/**
 * Usage and cost (`/efficiency`): the estimated spend and where today's use stands against the budget first, then the
 * savings, the real-versus-simulated comparison, budgets (unset limits say so), safety limits, usage by analysis step and
 * the model calls, in collapsed sections. Everything is labelled Estimated, and Simulated when the deterministic provider
 * produced it. `?case=` scopes the page to one case and `?agent=` filters the model calls.
 */
export function EfficiencyPage() {
  const auth = useAuth();
  const { can } = useSession();
  const allowed = auth.status === 'ready' && can('telemetry:read');
  const [caseId, setCaseId] = useUrlState('case', CASE_CODEC);
  const query = useApiQuery(
    'efficiency.overview',
    { query: caseId ? { caseId } : {} },
    { enabled: allowed, placeholderData: keepPreviousData },
  );
  const refreshing = query.isFetching && !query.isPending;
  return (
    <>
      <PageHeader
        title="Usage and cost"
        description="What the analysis spends, and where it could spend less."
        help={PAGE_HELP}
        actions={
          allowed ? (
            <Button
              variant="secondary"
              icon={<RefreshCwIcon />}
              loading={refreshing}
              disabledFocusable={query.isPending}
              onClick={() => void query.refetch()}
            >
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </Button>
          ) : undefined
        }
      />
      <PermissionGate
        permission="telemetry:read"
        subject="Usage and cost"
        grantedTo="Engineers, reviewers, managers and administrators"
        skeleton={SKELETON}
      >
        <ScopeBar caseId={caseId} onChange={setCaseId} />
        <QueryBoundary query={query} subject="Usage and cost" skeleton={SKELETON}>
          {(data, meta) => (
            <EfficiencyContent overview={data} caseId={caseId} isRefreshing={meta.isRefreshing} />
          )}
        </QueryBoundary>
      </PermissionGate>
    </>
  );
}
