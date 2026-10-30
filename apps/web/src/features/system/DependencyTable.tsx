'use client';

import type { DependencyHealth } from '@caseguard/schemas';
import {
  NOT_AVAILABLE,
  Panel,
  ProvenanceBadge,
  StatusBadge,
  formatNumber,
  formatTimeUtc,
  type DataTableColumn,
} from '@caseguard/ui';
import { ScrollTable } from '../../components/common/ScrollTable';
import { HEALTH_BADGES } from '../../lib/labels';
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
export function DependencyTable({ dependencies }: { dependencies: readonly DependencyHealth[] }) {
  const styles = useSystemStyles();
  const columns: DataTableColumn<DependencyHealth>[] = [
    {
      id: 'name',
      header: 'Dependency',
      rowHeader: true,
      cell: (row) => (
        <span className={styles.cellStack}>
          <strong>{humanize(row.name)}</strong>
          <span className={styles.cellMuted}>{KIND_LABELS[row.kind]}</span>
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      cell: (row) => {
        const badge = HEALTH_BADGES[row.status];
        return <StatusBadge status={badge.status} label={badge.label} />;
      },
    },
    {
      id: 'real',
      header: 'Real or simulated',
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
      cell: (row) =>
        row.latencyMs === null
          ? NOT_AVAILABLE
          : `${formatNumber(row.latencyMs, { maximumFractionDigits: 1 })} ms`,
    },
    { id: 'detail', header: 'Detail', cell: (row) => <span>{row.detail}</span> },
    {
      id: 'checked',
      header: 'Checked',
      cell: (row) => formatTimeUtc(row.checkedAt, { seconds: true }),
    },
  ];
  return (
    <Panel
      title="Dependencies"
      description="Each row is one thing the platform depends on, checked by the API just now."
      help="A dependency marked Simulated stand-in runs inside the API process or is synthetic (for example the local object store, the built-in keyword search and the deterministic AI provider). It is real code, but it is not the cloud service it stands in for. Unknown means the dependency is configured but is not probed from here, so it is never reported as healthy."
    >
      <ScrollTable
        label="Dependencies, scrollable"
        minWidth={880}
        caption="Dependencies and their health"
        columns={columns}
        rows={dependencies}
        getRowId={(row) => row.name}
      />
    </Panel>
  );
}
