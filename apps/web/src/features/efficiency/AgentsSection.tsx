'use client';

import { AGENT_LABELS, type EfficiencyOverview } from '@caseguard/schemas';
import { HelpButton, formatNumber, formatProbability } from '@caseguard/ui';
import { ProgressBar } from '@fluentui/react-components';
import { ResponsiveTable, type ResponsiveColumn } from '../../lib/advanced-view-parts';
import { PROVIDER_LABELS } from '../../lib/labels';
import { tokensText } from './model';
import { useUsageStyles } from './styles';

type AgentRow = EfficiencyOverview['byAgent'][number];
type ModelRow = EfficiencyOverview['byModel'][number];

const HELP =
  'Usage per analysis step (an analysis agent: a step of the analysis that asks the model for help) and per model. "Typical request" compares the average input of one call with the per-request input limit, so a value near 100% means calls are close to being refused for size. No figure here is about a person.';

function AgentUse({ row }: { row: AgentRow }) {
  const styles = useUsageStyles();
  return (
    <div className={styles.use}>
      <ProgressBar
        className={styles.useBar}
        value={row.budgetUtilization}
        max={1}
        aria-label={`${AGENT_LABELS[row.agent]}: a typical request uses ${Math.round(row.budgetUtilization * 100)} percent of the per-request input limit`}
        color={row.budgetUtilization >= 0.9 ? 'warning' : 'brand'}
      />
      <span>{formatProbability(row.budgetUtilization, 0)}</span>
    </div>
  );
}

const ms = (value: number): string => `${formatNumber(value, { maximumFractionDigits: 1 })} ms`;

const AGENT_COLUMNS: readonly ResponsiveColumn<AgentRow>[] = [
  {
    id: 'agent',
    header: 'Analysis step',
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
    id: 'tokens',
    header: 'Tokens (in / out)',
    align: 'end',
    cell: (row) => `${tokensText(row.promptTokens)} / ${tokensText(row.completionTokens)}`,
    sortValue: (row) => row.promptTokens + row.completionTokens,
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
    cell: (row) => ms(row.avgLatencyMs),
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
    width: '176px',
    cell: (row) => <AgentUse row={row} />,
    sortValue: (row) => row.budgetUtilization,
  },
];

const MODEL_COLUMNS: readonly ResponsiveColumn<ModelRow>[] = [
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
    cell: (row) => ms(row.avgLatencyMs),
    sortValue: (row) => row.avgLatencyMs,
  },
];

export interface AgentsSectionProps {
  byAgent: readonly AgentRow[];
  byModel: readonly ModelRow[];
}

/** Usage by analysis step and by model: where the tokens go, never who spent them. */
export function AgentsSection({ byAgent, byModel }: AgentsSectionProps) {
  const styles = useUsageStyles();
  return (
    <div className={styles.stack}>
      <div className={styles.head}>
        <p className={styles.text}>Where the tokens go: by analysis step and by model.</p>
        <HelpButton label="About usage by step and model" title="Usage by step and model">
          {HELP}
        </HelpButton>
      </div>
      <ResponsiveTable
        caption="Usage by analysis step"
        minWidth={1040}
        columns={AGENT_COLUMNS}
        rows={byAgent}
        getRowId={(row) => row.agent}
        dense
        empty="No analysis step has run yet."
      />
      <ResponsiveTable
        caption="Usage by model"
        minWidth={520}
        columns={MODEL_COLUMNS}
        rows={byModel}
        getRowId={(row) => `${row.provider}:${row.model}`}
        dense
        empty="No model has run yet."
      />
    </div>
  );
}
