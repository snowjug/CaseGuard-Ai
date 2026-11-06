'use client';

import type {
  DependencyHealth,
  HealthStatus,
  ProviderStatus,
  RequestMetrics,
  SystemHealth,
} from '@caseguard/schemas';
import {
  AccordionItem,
  Badge,
  BlurFade,
  Button,
  HelpButton,
  LoadingSkeleton,
  NOT_AVAILABLE,
  PageHeader,
  ProvenanceBadge,
  RelativeTime,
  STATUS_META,
  formatDuration,
  formatNumber,
  formatProbability,
  type AccordionItemProps,
  type ToneName,
} from '@caseguard/ui';
import { keepPreviousData, useQueryClient } from '@tanstack/react-query';
import {
  ActivityIcon,
  BotIcon,
  DatabaseIcon,
  GaugeIcon,
  NetworkIcon,
  RefreshCwIcon,
  ServerCogIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { PermissionGate } from '../../components/common/PermissionGate';
import { QueryBoundary, type BoundaryQuery } from '../../components/common/QueryBoundary';
import { QueryErrorState } from '../../components/common/QueryErrorState';
import { useApiQuery } from '../../lib/api/hooks';
import { invalidateRoutes } from '../../lib/api/query-keys';
import { useAuth } from '../../lib/auth/context';
import { useSession } from '../../lib/auth/session';
import {
  DetailSections,
  FactList,
  StateBadge,
  SummaryCard,
  ViewSkeleton,
} from '../../lib/advanced-view-parts';
import { HEALTH_BADGES } from '../../lib/labels';
import { useShortcut } from '../../lib/shortcuts';
import { DependenciesTable } from './DependencyTable';
import { HealthBadge } from './health';
import { ModelCallsContent, RequestsContent, SecurityContent } from './MetricsPanels';
import { CheckAgainButton, PROVIDER_HELP, ProviderDetails } from './ProviderPanel';
import { RealHereContent } from './ValidationPanel';
import { humanize, useSystemStyles } from './styles';

const SKELETON = <ViewSkeleton label="Loading system status" sections={7} />;

const PAGE_HELP =
  'System status shows what this environment is made of and whether each part works: the database, schema migrations, storage, search, cache, identity and the AI provider, plus counters kept in the API process. It is honest about stand-ins: anything that runs inside the API instead of as a cloud service is marked Simulated, and an integration that has not been exercised against a live service says so.';

const TONE: Record<HealthStatus, ToneName> = {
  healthy: 'productive',
  degraded: 'uncertain',
  unhealthy: 'unsupported',
  unknown: 'neutral',
  disabled: 'neutral',
};

const HEADLINE: Record<HealthStatus, string> = {
  healthy: 'Everything is working',
  degraded: 'Working, but something needs attention',
  unhealthy: 'Something is not working',
  unknown: 'Some checks could not confirm their state',
  disabled: 'The checks are turned off',
};

function uptime(seconds: number): string {
  return seconds < 60 ? `${seconds} s` : formatDuration(Math.floor(seconds / 60));
}

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${formatNumber(count)} ${count === 1 ? one : many}`;

/** Dependencies that are not healthy and not switched off: the ones a person may need to look at. */
const needsAttention = (dependency: DependencyHealth): boolean =>
  dependency.status !== 'healthy' && dependency.status !== 'disabled';

function OverallCard({ health }: { health: SystemHealth }) {
  const total = health.dependencies.length;
  const healthy = health.dependencies.filter(
    (dependency) => dependency.status === 'healthy',
  ).length;
  const attention = health.dependencies.filter(needsAttention);
  const standIns = health.dependencies.filter((dependency) => dependency.simulated).length;
  const badge = HEALTH_BADGES[health.status];
  const Icon = STATUS_META[badge.status].icon;
  const description =
    total === 0
      ? 'The API reported no dependency checks.'
      : attention.length === 0
        ? `${formatNumber(healthy)} of ${formatNumber(total)} checks are healthy.`
        : `${formatNumber(healthy)} of ${formatNumber(total)} checks are healthy. ${attention
            .map((dependency) => humanize(dependency.name))
            .join(', ')} ${attention.length === 1 ? 'needs' : 'need'} attention.`;
  return (
    <SummaryCard
      title="Overall status"
      help="The worst status of the checks below."
      icon={<Icon />}
      tone={TONE[health.status]}
      headline={HEADLINE[health.status]}
      description={description}
      badges={
        <>
          <HealthBadge status={health.status} />
          {attention.map((dependency) => {
            const state = HEALTH_BADGES[dependency.status];
            return (
              <Badge
                key={dependency.name}
                tone={STATUS_META[state.status].tone}
                icon={<ActivityIcon />}
                title={dependency.detail}
              >
                {humanize(dependency.name)}: {state.label}
              </Badge>
            );
          })}
          {standIns > 0 ? (
            <ProvenanceBadge kind="simulated" label={plural(standIns, 'simulated stand-in')} />
          ) : null}
        </>
      }
      factsLabel="Service details"
      facts={[
        { id: 'service', label: 'Service', value: `${health.service} ${health.version}` },
        { id: 'env', label: 'Environment', value: health.environment },
        { id: 'uptime', label: 'Uptime', value: uptime(health.uptimeSeconds) },
        {
          id: 'commit',
          label: 'Build commit',
          value: health.commit ?? 'Not recorded',
          mono: health.commit !== null,
        },
        { id: 'checked', label: 'Checked', value: <RelativeTime value={health.checkedAt} /> },
      ]}
    />
  );
}

type DataSectionProps = Omit<AccordionItemProps, 'open' | 'onOpenChange' | 'defaultOpen'> & {
  /** The section's data could not be loaded: it opens by itself so the message and Retry are seen. */
  failed: boolean;
};

function DataSection({ failed, children, ...item }: DataSectionProps) {
  const [open, setOpen] = useState(false);
  return (
    <AccordionItem {...item} open={open || failed} onOpenChange={setOpen}>
      {children}
    </AccordionItem>
  );
}

/** What one section shows while its own request loads or after it failed; the rest of the page keeps working. */
function SectionState<T>({
  query,
  subject,
  label,
  children,
}: {
  query: BoundaryQuery<T>;
  subject: string;
  label: string;
  children: (data: T) => ReactNode;
}) {
  if (query.isPending) return <LoadingSkeleton variant="text" count={3} label={label} />;
  if (query.isError || query.data === undefined) {
    return (
      <QueryErrorState
        error={query.error}
        subject={subject}
        compact
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  return <>{children(query.data)}</>;
}

function MigrationsContent({ migrations }: { migrations: SystemHealth['migrations'] }) {
  const styles = useSystemStyles();
  const pending = migrations.pending;
  return (
    <div className={styles.stack}>
      <div className={styles.head}>
        {pending > 0 ? (
          <StateBadge
            status="uncertain"
            label={`${formatNumber(pending)} pending`}
            title="Known database changes that have not been applied yet."
          />
        ) : (
          <StateBadge
            status="productive"
            label="Up to date"
            title="Every known database change has been applied."
          />
        )}
        <HelpButton label="About migrations" title="Migrations">
          Migrations create and change the database tables. Pending migrations are known changes
          that have not been applied yet; the API normally applies them when it starts in local
          runs.
        </HelpButton>
      </div>
      <FactList
        label="Migration details"
        items={[
          { id: 'applied', label: 'Applied', value: formatNumber(migrations.applied) },
          { id: 'pending', label: 'Pending', value: formatNumber(migrations.pending) },
          {
            id: 'latest',
            label: 'Latest applied',
            value: migrations.latest ?? NOT_AVAILABLE,
            mono: migrations.latest !== null,
          },
        ]}
      />
    </div>
  );
}

function Content({
  health,
  provider,
  metrics,
  isRefreshing,
}: {
  health: SystemHealth;
  provider: BoundaryQuery<ProviderStatus>;
  metrics: BoundaryQuery<RequestMetrics>;
  isRefreshing: boolean;
}) {
  const styles = useSystemStyles();
  const attention = health.dependencies.filter(needsAttention).length;
  const standIns = health.dependencies.filter((dependency) => dependency.simulated).length;
  const providerData = provider.data;
  const metricsData = metrics.data;
  return (
    <div className={styles.page} aria-busy={isRefreshing}>
      <BlurFade index={0}>
        <OverallCard health={health} />
      </BlurFade>
      <BlurFade index={1}>
        <DetailSections>
          <AccordionItem
            headingLevel={2}
            icon={<NetworkIcon />}
            title="Dependencies"
            subtitle={`${formatNumber(health.dependencies.length)} checked · ${formatNumber(standIns)} simulated`}
            badge={
              attention > 0 ? (
                <StateBadge
                  status="uncertain"
                  label={`${formatNumber(attention)} need attention`}
                  title="Dependencies that are not healthy and not switched off."
                />
              ) : undefined
            }
            defaultOpen
          >
            <DependenciesTable dependencies={health.dependencies} />
          </AccordionItem>
          <AccordionItem
            headingLevel={2}
            icon={<ShieldCheckIcon />}
            title="What is real here"
            subtitle="Read this before presenting: what runs for real, and what is a stand-in."
          >
            <RealHereContent health={health} />
          </AccordionItem>
          <DataSection
            failed={provider.isError}
            headingLevel={2}
            icon={<BotIcon />}
            title="AI provider"
            subtitle={
              providerData
                ? `${providerData.simulated ? 'Simulated' : 'Configured'} · ${providerData.model}`
                : 'Which provider runs the analysis'
            }
            badge={
              provider.isError ? (
                <StateBadge status="unsupported" label="Could not load" />
              ) : undefined
            }
          >
            <SectionState
              query={provider}
              subject="The AI provider status"
              label="Loading the AI provider status"
            >
              {(data) => (
                <div className={styles.stack}>
                  <div className={styles.head}>
                    <p className={styles.text}>
                      Which provider runs the analysis, and how far it has been validated.
                    </p>
                    <HelpButton label="About the AI provider" title="AI provider">
                      {PROVIDER_HELP}
                    </HelpButton>
                    <span className={styles.headSpacer}>
                      <CheckAgainButton
                        checking={provider.isFetching}
                        onClick={() => void provider.refetch()}
                      />
                    </span>
                  </div>
                  <ProviderDetails provider={data} />
                </div>
              )}
            </SectionState>
          </DataSection>
          <AccordionItem
            headingLevel={2}
            icon={<DatabaseIcon />}
            title="Migrations"
            subtitle={
              health.migrations.pending > 0
                ? `${plural(health.migrations.pending, 'change')} waiting to be applied`
                : `Up to date · ${formatNumber(health.migrations.applied)} applied`
            }
          >
            <MigrationsContent migrations={health.migrations} />
          </AccordionItem>
          <DataSection
            failed={metrics.isError}
            headingLevel={2}
            icon={<GaugeIcon />}
            title="Requests"
            subtitle={
              metricsData
                ? `${formatNumber(metricsData.totalRequests)} requests · ${formatProbability(metricsData.errorRate, 1)} errors`
                : 'Traffic and speed of the API'
            }
            badge={
              metrics.isError ? (
                <StateBadge status="unsupported" label="Could not load" />
              ) : undefined
            }
          >
            <SectionState
              query={metrics}
              subject="The request metrics"
              label="Loading request metrics"
            >
              {(data) => <RequestsContent metrics={data} />}
            </SectionState>
          </DataSection>
          <AccordionItem
            headingLevel={2}
            icon={<ServerCogIcon />}
            title="Model calls"
            subtitle={
              metricsData
                ? `${formatNumber(metricsData.modelExecutions.total)} calls · ${formatNumber(metricsData.modelExecutions.failures)} failed`
                : 'Calls made to the AI provider'
            }
          >
            <SectionState
              query={metrics}
              subject="The request metrics"
              label="Loading request metrics"
            >
              {(data) => (
                <ModelCallsContent metrics={data} providerSimulated={health.provider.simulated} />
              )}
            </SectionState>
          </AccordionItem>
          <AccordionItem
            headingLevel={2}
            icon={<ShieldAlertIcon />}
            title="Security events"
            subtitle="Refused or flagged requests since the API started"
          >
            <SectionState
              query={metrics}
              subject="The request metrics"
              label="Loading request metrics"
            >
              {(data) => <SecurityContent metrics={data} />}
            </SectionState>
          </AccordionItem>
        </DetailSections>
      </BlurFade>
    </div>
  );
}

/**
 * System status (`/system`): the overall state first, then dependencies with simulated stand-ins labelled, what is real
 * here, the AI provider, migrations and the in-process request, model and security counters, in collapsed sections.
 * Needs `telemetry:read`; a role without it gets a plain explanation instead of a failed request. The provider and the
 * counters load on their own: one failing does not take the page down.
 */
export function SystemHealthPage() {
  const auth = useAuth();
  const { can } = useSession();
  const queryClient = useQueryClient();
  const allowed = auth.status === 'ready' && can('telemetry:read');
  const health = useApiQuery('system.health', undefined, {
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
  const provider = useApiQuery('system.provider', undefined, { enabled: allowed });
  const metrics = useApiQuery('system.metrics', undefined, { enabled: allowed });
  const refresh = (): void => {
    void invalidateRoutes(queryClient, auth.identityKey, [
      'system.health',
      'system.metrics',
      'system.provider',
    ]);
  };
  useShortcut({
    id: 'system-refresh',
    keys: 'r',
    description: 'Refresh system status',
    group: 'System status',
    enabled: allowed,
    handler: refresh,
  });
  const refreshing = health.isFetching && !health.isPending;

  return (
    <>
      <PageHeader
        title="System status"
        description="Whether the services behind the review are healthy."
        help={PAGE_HELP}
        actions={
          allowed ? (
            <Button
              variant="secondary"
              icon={<RefreshCwIcon />}
              loading={refreshing}
              disabledFocusable={health.isPending}
              onClick={refresh}
            >
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </Button>
          ) : undefined
        }
      />
      <PermissionGate
        permission="telemetry:read"
        subject="System status"
        grantedTo="Engineers, reviewers, managers and administrators"
        skeleton={SKELETON}
      >
        <QueryBoundary query={health} subject="System status" skeleton={SKELETON}>
          {(data, meta) => (
            <Content
              health={data}
              provider={provider}
              metrics={metrics}
              isRefreshing={meta.isRefreshing}
            />
          )}
        </QueryBoundary>
      </PermissionGate>
    </>
  );
}
