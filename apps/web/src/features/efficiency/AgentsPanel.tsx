'use client';

import { AGENT_LABELS, type EfficiencyOverview } from '@caseguard/schemas';
import { DataTable, Panel, type DataTableColumn } from '@caseguard/ui';
import { ProgressBar } from '@fluentui/react-components';
import { formatNumber, formatProbability } from '../../lib/format';
import { ReadableTable } from '../quality/ReadableTable';
import { PROVIDER_LABELS } from '../../lib/labels';
import { tokensText } from './model';

type AgentRow = EfficiencyOverview['byAgent'][number];
type ModelRow = EfficiencyOverview['byModel'][number];

const HELP =
  'Usage per analysis agent (a step of the analysis that asks the model for help) and per model. "Typical request" compares the average input of one call with the per-request input limit, so a value near 100% means calls are close to being refused for size. No figure here is about a person.';

function AgentUse({ row }: { row: AgentRow }) {
  return (
    <div>
      <ProgressBar
        value={row.budgetUtilization}
        max={1}
        aria-label={`${AGENT_LABELS[row.agent]}: a typical request uses ${Math.round(row.budgetUtilization * 100)} percent of the per-request input limit`}
        color={row.budgetUtilization >= 0.9 ? 'warning' : 'brand'}
      />
      <span>{formatProbability(row.budgetUtilization, 0)}</span>
    </div>
  );
}

const AGENT_COLUMNS: readonly DataTableColumn<AgentRow>[] = [
  {
    id: 'agent',
    header: 'Agent',
    rowHeader: true,
    cell: (row) => AGENT_LABELS[row.agent],
    sortValue: (row) => AGENT_LABELS[row.agent],
  },
  {
    id: 'executions',
    header: 'Calls',
    align: 'end',
    cell: (row) => tokensText(row.executions),
    sortValue: (row) => row.executions,
  },
  {
    id: 'prompt',
    header: 'Prompt tokens',
    align: 'end',
    cell: (row) => tokensText(row.promptTokens),
    sortValue: (row) => row.promptTokens,
  },
  {
    id: 'completion',
    header: 'Completion tokens',
    align: 'end',
    cell: (row) => tokensText(row.completionTokens),
    sortValue: (row) => row.completionTokens,
  },
  {
    id: 'cached',
    header: 'Cached tokens',
    align: 'end',
    cell: (row) => tokensText(row.cachedTokens),
    sortValue: (row) => row.cachedTokens,
  },
  {
    id: 'latency',
    header: 'Average latency',
    align: 'end',
    cell: (row) => `${formatNumber(row.avgLatencyMs, { maximumFractionDigits: 1 })} ms`,
    sortValue: (row) => row.avgLatencyMs,
  },
  {
    id: 'cache-rate',
    header: 'Cache hits',
    align: 'end',
    cell: (row) => formatProbability(row.cacheHitRate, 0),
    sortValue: (row) => row.cacheHitRate,
  },
  {
    id: 'failures',
    header: 'Failures',
    align: 'end',
    cell: (row) => tokensText(row.failures),
    sortValue: (row) => row.failures,
  },
  {
    id: 'savings',
    header: 'Estimated tokens saved',
    align: 'end',
    cell: (row) => tokensText(row.estimatedSavingsTokens),
    sortValue: (row) => row.estimatedSavingsTokens,
  },
  {
    id: 'use',
    header: 'Typical request vs limit',
    cell: (row) => <AgentUse row={row} />,
    sortValue: (row) => row.budgetUtilization,
  },
];

const MODEL_COLUMNS: readonly DataTableColumn<ModelRow>[] = [
  {
    id: 'model',
    header: 'Model',
    rowHeader: true,
    cell: (row) => row.model,
    sortValue: (row) => row.model,
  },
  {
    id: 'provider',
    header: 'Provider',
    cell: (row) => PROVIDER_LABELS[row.provider],
    sortValue: (row) => row.provider,
  },
  {
    id: 'executions',
    header: 'Calls',
    align: 'end',
    cell: (row) => tokensText(row.executions),
    sortValue: (row) => row.executions,
  },
  {
    id: 'tokens',
    header: 'Total tokens',
    align: 'end',
    cell: (row) => tokensText(row.totalTokens),
    sortValue: (row) => row.totalTokens,
  },
  {
    id: 'latency',
    header: 'Average latency',
    align: 'end',
    cell: (row) => `${formatNumber(row.avgLatencyMs, { maximumFractionDigits: 1 })} ms`,
    sortValue: (row) => row.avgLatencyMs,
  },
];

export interface AgentsPanelProps {
  byAgent: readonly AgentRow[];
  byModel: readonly ModelRow[];
}

/** Usage by analysis agent and by model: where the tokens go, never who spent them. */
export function AgentsPanel({ byAgent, byModel }: AgentsPanelProps) {
  return (
    <Panel
      title="Usage by agent and model"
      help={HELP}
      description="Where the tokens go: by analysis step and by model."
    >
      <ReadableTable columns={AGENT_COLUMNS.length}>
        <DataTable
          caption="Usage by agent"
          columns={AGENT_COLUMNS}
          rows={byAgent}
          getRowId={(row) => row.agent}
          dense
          empty="No agent has run yet."
        />
      </ReadableTable>
      <ReadableTable columns={MODEL_COLUMNS.length}>
        <DataTable
          caption="Usage by model"
          columns={MODEL_COLUMNS}
          rows={byModel}
          getRowId={(row) => `${row.provider}:${row.model}`}
          dense
          empty="No model has run yet."
        />
      </ReadableTable>
    </Panel>
  );
}
