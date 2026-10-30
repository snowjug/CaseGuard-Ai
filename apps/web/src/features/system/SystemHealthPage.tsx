'use client';

import type { SystemHealth } from '@caseguard/schemas';
import {
  KeyValueList,
  NOT_AVAILABLE,
  PageHeader,
  Panel,
  StatusBadge,
  formatDateTimeUtc,
  formatDuration,
  formatNumber,
  formatTimeUtc,
} from '@caseguard/ui';
import { Button, mergeClasses } from '@fluentui/react-components';
import { ArrowSyncRegular } from '@fluentui/react-icons';
import { keepPreviousData, useQueryClient } from '@tanstack/react-query';
import { PermissionGate } from '../../components/common/PermissionGate';
import { QueryBoundary } from '../../components/common/QueryBoundary';
import { ProviderStatusSection } from '../../components/system/ProviderStatus';
import { useApiQuery } from '../../lib/api/hooks';
import { invalidateRoutes } from '../../lib/api/query-keys';
import { useAuth } from '../../lib/auth/context';
import { useSession } from '../../lib/auth/session';
import { HEALTH_BADGES } from '../../lib/labels';
import { useShortcut } from '../../lib/shortcuts';
import { DependencyTable } from './DependencyTable';
import { MetricsSection } from './MetricsPanels';
import { SystemHealthSkeleton } from './Skeleton';
import { useSystemStyles } from './styles';
import { ValidationPanel } from './ValidationPanel';

const PAGE_HELP =
  'System Health shows what this environment is made of and whether each part works: the database, schema migrations, storage, search, cache, identity and the AI provider, plus counters kept in the API process. It is honest about stand-ins: anything that runs inside the API instead of as a cloud service is marked Simulated, and an integration that has not been exercised against a live service says so.';

function uptime(seconds: number): string {
  return seconds < 60 ? `${seconds} s` : formatDuration(Math.floor(seconds / 60));
}

function OverallPanel({ health }: { health: SystemHealth }) {
  const styles = useSystemStyles();
  const badge = HEALTH_BADGES[health.status];
  return (
    <Panel title="Overall status" description="Worst status of the checks below.">
      <div className={styles.headRow}>
        <StatusBadge status={badge.status} label={badge.label} />
        <strong>
          {health.service} {health.version}
        </strong>
      </div>
      <KeyValueList
        columns={3}
        aria-label="Service details"
        items={[
          { id: 'env', label: 'Environment', value: health.environment },
          { id: 'uptime', label: 'Uptime', value: uptime(health.uptimeSeconds) },
          {
            id: 'commit',
            label: 'Build commit',
            value: health.commit ?? 'Not recorded',
            mono: health.commit !== null,
          },
          {
            id: 'checked',
            label: 'Checked',
            value: formatDateTimeUtc(health.checkedAt, { seconds: true }),
          },
        ]}
      />
    </Panel>
  );
}

function MigrationsPanel({ migrations }: { migrations: SystemHealth['migrations'] }) {
  const pending = migrations.pending;
  return (
    <Panel
      title="Migrations"
      description="Schema changes applied to the database."
      help="Migrations create and change the database tables. Pending migrations are known changes that have not been applied yet; the API normally applies them when it starts in local runs."
    >
      <div>
        {pending > 0 ? (
          <StatusBadge status="uncertain" label={`${formatNumber(pending)} pending`} />
        ) : (
          <StatusBadge status="productive" label="Up to date" />
        )}
      </div>
      <KeyValueList
        layout="inline"
        aria-label="Migration details"
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
    </Panel>
  );
}

function Content({ health, isRefreshing }: { health: SystemHealth; isRefreshing: boolean }) {
  const styles = useSystemStyles();
  return (
    <div
      className={mergeClasses(styles.page, isRefreshing && styles.busy)}
      aria-busy={isRefreshing}
    >
      <OverallPanel health={health} />
      <ValidationPanel health={health} />
      <DependencyTable dependencies={health.dependencies} />
      <div className={styles.band}>
        <ProviderStatusSection />
        <MigrationsPanel migrations={health.migrations} />
      </div>
      <MetricsSection enabled providerSimulated={health.provider.simulated} />
    </div>
  );
}

/**
 * System Health (`/system`): dependency health with simulated stand-ins labelled, migrations, the AI provider with its
 * validation note, and the in-process request, model and security counters. Needs `telemetry:read`; a role without it
 * gets a plain explanation instead of a failed request.
 */
export function SystemHealthPage() {
  const styles = useSystemStyles();
  const auth = useAuth();
  const { can } = useSession();
  const queryClient = useQueryClient();
  const allowed = auth.status === 'ready' && can('telemetry:read');
  const health = useApiQuery('system.health', undefined, {
    enabled: allowed,
    placeholderData: keepPreviousData,
  });
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
    group: 'System Health',
    enabled: allowed,
    handler: refresh,
  });

  return (
    <>
      <PageHeader
        title="System Health"
        description="Dependencies, migrations, the AI provider and in-process metrics for this environment."
        help={PAGE_HELP}
        actions={
          allowed ? (
            <div className={styles.actions}>
              <Button
                appearance="outline"
                icon={<ArrowSyncRegular />}
                disabled={health.isFetching}
                onClick={refresh}
              >
                {health.isFetching && !health.isPending ? 'Refreshing…' : 'Refresh'}
              </Button>
              {health.data ? (
                <span className={styles.updated}>
                  Checked {formatTimeUtc(health.data.checkedAt, { seconds: true })}
                </span>
              ) : null}
            </div>
          ) : undefined
        }
      />
      <PermissionGate
        permission="telemetry:read"
        subject="System Health"
        grantedTo="Engineers, reviewers, managers and administrators"
        skeleton={<SystemHealthSkeleton />}
      >
        <QueryBoundary query={health} subject="System health" skeleton={<SystemHealthSkeleton />}>
          {(data, meta) => <Content health={data} isRefreshing={meta.isRefreshing} />}
        </QueryBoundary>
      </PermissionGate>
    </>
  );
}
