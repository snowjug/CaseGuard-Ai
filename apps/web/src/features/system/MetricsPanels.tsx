'use client';

import type { RequestMetrics } from '@caseguard/schemas';
import {
  Button,
  HelpButton,
  ProvenanceBadge,
  RelativeTime,
  formatNumber,
  formatProbability,
  sortRows,
  type SortState,
} from '@caseguard/ui';
import { useState } from 'react';
import { ResponsiveTable, StatTiles, type ResponsiveColumn } from '../../lib/advanced-view-parts';
import { useSystemStyles } from './styles';

type RouteRow = RequestMetrics['byRoute'][number];

/** The routes shown before "Show all": the busiest (or, sorted another way, the first) few of up to a hundred. */
const TOP_ROUTES = 8;

const ms = (value: number): string => `${formatNumber(value, { maximumFractionDigits: 1 })} ms`;

function RoutesTable({ rows }: { rows: readonly RouteRow[] }) {
  const styles = useSystemStyles();
  const [sort, setSort] = useState<SortState | null>({
    columnId: 'count',
    direction: 'descending',
  });
  const [showAll, setShowAll] = useState(false);
  const columns: ResponsiveColumn<RouteRow>[] = [
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
      width: '112px',
      sortValue: (row) => row.count,
      cell: (row) => formatNumber(row.count),
    },
    {
      id: 'errors',
      header: 'Errors',
      align: 'end',
      width: '96px',
      sortValue: (row) => row.errors,
      cell: (row) => formatNumber(row.errors),
    },
    {
      id: 'p95',
      header: '95th percentile',
      align: 'end',
      width: '144px',
      sortValue: (row) => row.p95Ms,
      cell: (row) => ms(row.p95Ms),
    },
  ];
  // Sorted here, before the cut, so "slowest first" shows the slowest routes and not the busiest eight sorted again.
  const ordered = sortRows(rows, columns, sort);
  const shown = showAll ? ordered : ordered.slice(0, TOP_ROUTES);
  return (
    <div className={styles.stack}>
      <ResponsiveTable
        caption="Requests by route"
        minWidth={520}
        columns={columns}
        rows={shown}
        getRowId={(row) => `${row.method} ${row.route}`}
        sort={sort}
        onSortChange={setSort}
        dense
      />
      {rows.length > TOP_ROUTES ? (
        <div>
          <Button variant="ghost" size="sm" onClick={() => setShowAll((value) => !value)}>
            {showAll ? `Show the top ${TOP_ROUTES}` : `Show all ${rows.length} routes`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Request totals and latency, then the routes: counters of the API process, never of a person. */
export function RequestsContent({ metrics }: { metrics: RequestMetrics }) {
  const styles = useSystemStyles();
  return (
    <div className={styles.stack}>
      <div className={styles.head}>
        <p className={styles.text}>
          Counting since <RelativeTime value={metrics.since} />. The counters live in this API
          instance&apos;s memory and reset when it restarts.
        </p>
        <HelpButton label="About request figures" title="Request figures">
          Latency is the time the API took to answer, in milliseconds. The 95th percentile means 95
          in 100 requests were answered at least this fast. These figures describe the process,
          never a person.
        </HelpButton>
      </div>
      <StatTiles
        label="Request totals and latency"
        items={[
          { id: 'total', label: 'Requests', value: formatNumber(metrics.totalRequests) },
          { id: 'errors', label: 'Errors', value: formatNumber(metrics.errorRequests) },
          { id: 'rate', label: 'Error rate', value: formatProbability(metrics.errorRate, 1) },
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
    </div>
  );
}

/** Calls made to the AI provider by this API instance, with the honest note when the provider is simulated. */
export function ModelCallsContent({
  metrics,
  providerSimulated,
}: {
  metrics: RequestMetrics;
  providerSimulated: boolean;
}) {
  const styles = useSystemStyles();
  return (
    <div className={styles.stack}>
      <div className={styles.head}>
        <p className={styles.text}>
          Calls made to the AI provider by this API instance since it started.
        </p>
        {providerSimulated ? <ProvenanceBadge kind="simulated" /> : null}
      </div>
      <StatTiles
        label="Model calls"
        items={[
          { id: 'total', label: 'Calls', value: formatNumber(metrics.modelExecutions.total) },
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
    </div>
  );
}

/** Counts of refused or flagged requests; only counts are kept, never the content. */
export function SecurityContent({ metrics }: { metrics: RequestMetrics }) {
  const styles = useSystemStyles();
  return (
    <div className={styles.stack}>
      <div className={styles.head}>
        <p className={styles.text}>Counts of refused or flagged requests since the API started.</p>
        <HelpButton label="About security events" title="Security events">
          Authentication failures are requests without a valid identity. Forbidden are requests
          refused by role. Rate limited are requests slowed down by the abuse limiter. Injection
          flags are case texts that looked like instructions to the model. Only counts are kept
          here, never the content.
        </HelpButton>
      </div>
      <StatTiles
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
    </div>
  );
}
