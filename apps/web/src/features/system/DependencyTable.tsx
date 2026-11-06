'use client';

import type { DependencyHealth } from '@caseguard/schemas';
import { NOT_AVAILABLE, ProvenanceBadge, RelativeTime, formatNumber } from '@caseguard/ui';
import { ResponsiveTable, type ResponsiveColumn } from '../../lib/advanced-view-parts';
import { HealthBadge } from './health';
import { humanize, useSystemStyles } from './styles';

const KIND_LABELS: Record<DependencyHealth['kind'], string> = {
  database: 'Database',
  migrations: 'Schema migrations',
  ai_provider: 'AI provider',
  search: 'Search',
  cache: 'Cache',
  storage: 'Object storage',
  identity: 'Identity',
  telemetry: 'Telemetry',
};

/**
 * Every dependency the API checked. A dependency the API flags as an in-process or synthetic stand-in carries the
 * Simulated badge in its own column (not only in the text), so no reader mistakes it for a live service.
 */
export function DependenciesTable({ dependencies }: { dependencies: readonly DependencyHealth[] }) {
  const styles = useSystemStyles();
  const columns: ResponsiveColumn<DependencyHealth>[] = [
    {
      id: 'name',
      header: 'Dependency',
      rowHeader: true,
      width: '200px',
      cell: (row) => {
        const title = humanize(row.name);
        const kind = KIND_LABELS[row.kind];
        return (
          <span className={styles.cellStack}>
            <strong>{title}</strong>
            {kind === title ? null : <span className={styles.cellMuted}>{kind}</span>}
          </span>
        );
      },
    },
    {
      id: 'status',
      header: 'Status',
      width: '120px',
      cell: (row) => <HealthBadge status={row.status} />,
    },
    {
      id: 'real',
      header: 'Source',
      width: '176px',
      cell: (row) =>
        row.simulated ? (
          <ProvenanceBadge kind="simulated" label="Simulated stand-in" />
        ) : (
          <span>Configured service</span>
        ),
    },
    {
      id: 'latency',
      header: 'Latency',
      align: 'end',
      width: '96px',
      cell: (row) =>
        row.latencyMs === null
          ? NOT_AVAILABLE
          : `${formatNumber(row.latencyMs, { maximumFractionDigits: 1 })} ms`,
    },
    {
      id: 'detail',
      header: 'Detail',
      cell: (row) => <span className={styles.detail}>{row.detail}</span>,
    },
    {
      id: 'checked',
      header: 'Checked',
      width: '128px',
      cell: (row) => <RelativeTime value={row.checkedAt} />,
    },
  ];
  return (
    <ResponsiveTable
      caption="Dependencies and their health"
      minWidth={880}
      columns={columns}
      rows={dependencies}
      getRowId={(row) => row.name}
    />
  );
}
