'use client';

import type { RequestMetrics } from '@caseguard/schemas';
import {
  LoadingSkeleton,
  Panel,
  ProvenanceBadge,
  formatDateTimeUtc,
  formatNumber,
  formatProbability,
  type DataTableColumn,
} from '@caseguard/ui';
import { ScrollTable } from '../../components/common/ScrollTable';
import { useApiQuery } from '../../lib/api/hooks';
import { useAuth } from '../../lib/auth/context';
import { QueryErrorState } from '../../components/common/QueryErrorState';
import { Stats } from './Stats';
import { useSystemStyles } from './styles';

type RouteRow = RequestMetrics['byRoute'][number];

const ms = (value: number): string => `${formatNumber(value, { maximumFractionDigits: 1 })} ms`;

function RoutesTable({ rows }: { rows: readonly RouteRow[] }) {
  const styles = useSystemStyles();
  const columns: DataTableColumn<RouteRow>[] = [
    {
      id: 'route',
      header: 'Route',
      rowHeader: true,
      sortValue: (row) => row.route,
      cell: (row) => (
        <span className={styles.mono}>
          {row.method} {row.route}
        </span>
      ),
    },
    {
      id: 'count',
      header: 'Requests',
      align: 'end',
      sortValue: (row) => row.count,
      cell: (row) => formatNumber(row.count),
    },
    {
      id: 'errors',
      header: 'Errors',
      align: 'end',
      sortValue: (row) => row.errors,
      cell: (row) => formatNumber(row.errors),
    },
    {
      id: 'p95',
      header: '95th percentile',
      align: 'end',
      sortValue: (row) => row.p95Ms,
      cell: (row) => ms(row.p95Ms),
    },
  ];
  return (
    <ScrollTable
      label="Requests by route, scrollable"
      minWidth={560}
      caption="Requests by route"
      columns={columns}
      rows={rows}
      getRowId={(row) => `${row.method} ${row.route}`}
      defaultSort={{ columnId: 'count', direction: 'descending' }}
      dense
    />
  );
}

function MetricsPanels({
  metrics,
  providerSimulated,
}: {
  metrics: RequestMetrics;
  providerSimulated: boolean;
}) {
  const styles = useSystemStyles();
  return (
    <>
      <Panel
        title="Requests"
        description={`Since ${formatDateTimeUtc(metrics.since, { seconds: true })}. The counters live in this API instance's memory and reset when it restarts.`}
        help="Latency is the time the API took to answer, in milliseconds. The 95th percentile means 95 in 100 requests were answered at least this fast. These figures describe the process, never a person."
      >
        <Stats
          label="Request totals and latency"
          items={[
            { id: 'total', label: 'Requests', value: formatNumber(metrics.totalRequests) },
            { id: 'errors', label: 'Errors', value: formatNumber(metrics.errorRequests) },
            {
              id: 'rate',
              label: 'Error rate',
              value: formatProbability(metrics.errorRate, 1),
            },
            { id: 'p50', label: 'Median latency', value: ms(metrics.latencyMs.p50) },
            { id: 'p95', label: '95th percentile', value: ms(metrics.latencyMs.p95) },
            { id: 'p99', label: '99th percentile', value: ms(metrics.latencyMs.p99) },
            { id: 'max', label: 'Slowest', value: ms(metrics.latencyMs.max) },
          ]}
        />
        {metrics.byRoute.length > 0 ? (
          <RoutesTable rows={metrics.byRoute} />
        ) : (
          <p className={styles.text}>No requests have been recorded since the API started.</p>
        )}
      </Panel>
      <div className={styles.band}>
        <Panel
          title="Model executions"
          description="Calls made to the AI provider by this API instance since it started."
          actions={providerSimulated ? <ProvenanceBadge kind="simulated" /> : undefined}
        >
          <Stats
            label="Model executions"
            items={[
              {
                id: 'total',
                label: 'Executions',
                value: formatNumber(metrics.modelExecutions.total),
              },
              {
                id: 'failures',
                label: 'Failures',
                value: formatNumber(metrics.modelExecutions.failures),
              },
              {
                id: 'latency',
                label: 'Average latency',
                value: ms(metrics.modelExecutions.avgLatencyMs),
              },
            ]}
          />
          {providerSimulated ? (
            <p className={styles.text}>
              The provider is the deterministic engine, so these executions are simulated and no
              language model was called.
            </p>
          ) : null}
        </Panel>
        <Panel
          title="Security events"
          description="Counts of refused or flagged requests since the API started."
          help="Authentication failures are requests without a valid identity. Forbidden are requests refused by role. Rate limited are requests slowed down by the abuse limiter. Injection flags are case texts that looked like instructions to the model. Only counts are kept here, never the content."
        >
          <Stats
            label="Security events"
            items={[
              {
                id: 'auth',
                label: 'Authentication failures',
                value: formatNumber(metrics.securityEvents.authFailures),
              },
              {
                id: 'forbidden',
                label: 'Forbidden',
                value: formatNumber(metrics.securityEvents.forbidden),
              },
              {
                id: 'rate',
                label: 'Rate limited',
                value: formatNumber(metrics.securityEvents.rateLimited),
              },
              {
                id: 'injection',
                label: 'Injection flags',
                value: formatNumber(metrics.securityEvents.injectionFlags),
              },
            ]}
          />
        </Panel>
      </div>
    </>
  );
}

/** Fetches `system.metrics`; a failure stays inside this section (the rest of the page keeps working) and offers Retry. */
export function MetricsSection({
  enabled,
  providerSimulated,
}: {
  enabled: boolean;
  providerSimulated: boolean;
}) {
  const auth = useAuth();
  const query = useApiQuery('system.metrics', undefined, {
    enabled: enabled && auth.status === 'ready',
  });
  if (query.isPending)
    return <LoadingSkeleton variant="card" count={2} label="Loading request metrics" />;
  if (query.isError || !query.data) {
    return (
      <QueryErrorState
        error={query.error}
        subject="The request metrics"
        compact
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  return <MetricsPanels metrics={query.data} providerSimulated={providerSimulated} />;
}
