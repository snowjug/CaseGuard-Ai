'use client';

import type { EfficiencyOverview } from '@caseguard/schemas';
import { EmptyState, Panel, ProvenanceBadge } from '@caseguard/ui';
import { DataBarVerticalRegular } from '@fluentui/react-icons';
import { LinkButton } from '../../components/common/LinkButton';
import { formatNumber } from '../../lib/format';
import { useInsightStyles } from '../quality/styles';
import { rateText, tokensText, usdText } from './model';

const HELP =
  'Totals across the model executions recorded for the chosen scope. With the deterministic provider every token count and latency is simulated; with a live provider they would be reported by it. Cost stays unknown until an operator configures unit prices: prices are never built in.';

export interface TotalsPanelProps {
  totals: EfficiencyOverview['totals'];
  simulated: boolean;
}

/** The headline usage figures. Rates and averages are unknown ("—") until something has run, never `0%`. */
export function TotalsPanel({ totals, simulated }: TotalsPanelProps) {
  const styles = useInsightStyles();
  if (totals.executions === 0) {
    return (
      <Panel title="Token usage" help={HELP}>
        <EmptyState
          compact
          headingLevel={3}
          icon={<DataBarVerticalRegular />}
          title="No model executions recorded yet"
          description="Token usage appears here after a case has been analysed: every analysis step that asks the model for help is recorded with its tokens and timing."
          action={
            <LinkButton href="/cases" appearance="primary">
              Open Cases
            </LinkButton>
          }
        />
      </Panel>
    );
  }
  const tiles: { id: string; label: string; value: string; note: string }[] = [
    {
      id: 'executions',
      label: 'Model executions',
      value: tokensText(totals.executions),
      note: 'Recorded model calls',
    },
    {
      id: 'tokens',
      label: 'Total tokens',
      value: tokensText(totals.totalTokens),
      note: `${tokensText(totals.promptTokens)} prompt + ${tokensText(totals.completionTokens)} completion`,
    },
    {
      id: 'cached',
      label: 'Cached tokens',
      value: tokensText(totals.cachedTokens),
      note: 'Served from a cache',
    },
    {
      id: 'cost',
      label: 'Estimated cost',
      value: usdText(totals.estimatedCostUsd, 'Unknown'),
      note:
        totals.estimatedCostUsd === null
          ? 'No unit prices are configured'
          : 'From operator-supplied unit prices',
    },
    {
      id: 'latency',
      label: 'Average latency',
      value: `${formatNumber(totals.avgLatencyMs, { maximumFractionDigits: 1 })} ms`,
      note: simulated ? 'Simulated by the offline provider' : 'Per model call',
    },
    {
      id: 'cache-rate',
      label: 'Cache hit rate',
      value: rateText(totals.cacheHitRate, totals.executions),
      note: 'Share of calls answered from a cache',
    },
    {
      id: 'failure-rate',
      label: 'Failure rate',
      value: rateText(totals.failureRate, totals.executions, 1),
      note: 'Share of calls that did not succeed',
    },
  ];
  return (
    <Panel
      title="Token usage"
      help={HELP}
      description="Tokens and timing across the recorded model executions."
      actions={
        <>
          <ProvenanceBadge kind="estimated" />
          {simulated ? <ProvenanceBadge kind="simulated" /> : null}
        </>
      }
    >
      <ul className={styles.tiles}>
        {tiles.map((tile) => (
          <li key={tile.id} className={styles.tile}>
            <p className={styles.tileLabel}>{tile.label}</p>
            <p className={styles.tileValue}>{tile.value}</p>
            <p className={styles.tileNote}>{tile.note}</p>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
