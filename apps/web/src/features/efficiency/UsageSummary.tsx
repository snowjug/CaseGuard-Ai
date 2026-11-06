'use client';

import type { EfficiencyOverview } from '@caseguard/schemas';
import {
  Badge,
  ButtonLink,
  NumberTicker,
  ProvenanceBadge,
  RelativeTime,
  formatNumber,
} from '@caseguard/ui';
import { ArrowRightIcon, BriefcaseIcon, CoinsIcon } from 'lucide-react';
import { StateBadge, SummaryCard } from '../../lib/advanced-view-parts';
import { budgetState, rateText, tokensText, usdText } from './model';
import { useUsageStyles } from './styles';

const HELP =
  'Totals across the model calls recorded for the chosen scope. With the deterministic provider every token count and latency is simulated; with a live provider they would be reported by it. Cost stays unknown until an operator configures unit prices: prices are never built in.';

export interface UsageSummaryProps {
  overview: EfficiencyOverview;
  /** Reference of the scoped case, or null when the page covers every case. */
  scope: string | null;
  busy: boolean;
}

/**
 * What the analysis has cost so far, at a glance: the estimated spend (unknown until unit prices exist, never `$0`),
 * where today's use stands against the budget, and the usage behind it. Rates and averages are unknown ("—") until
 * something has run, never `0%`.
 */
export function UsageSummary({ overview, scope, busy }: UsageSummaryProps) {
  const styles = useUsageStyles();
  const { totals, budgets, labels } = overview;
  if (totals.executions === 0) {
    return (
      <SummaryCard
        title="Estimated spend"
        help={HELP}
        icon={<CoinsIcon />}
        headline="No model calls recorded yet"
        description="Usage appears here after a case has been analysed: every analysis step that asks the model for help is recorded with its tokens and timing."
        busy={busy}
      >
        <div>
          <ButtonLink href="/cases" variant="primary" icon={<ArrowRightIcon />} iconPosition="end">
            Open cases
          </ButtonLink>
        </div>
      </SummaryCard>
    );
  }
  const budget = budgetState(budgets);
  const costKnown = totals.estimatedCostUsd !== null;
  return (
    <SummaryCard
      title="Estimated spend"
      help={HELP}
      icon={<CoinsIcon />}
      tone={budget.status === 'neutral' || budget.status === 'productive' ? 'brand' : budget.status}
      headline={costKnown ? usdText(totals.estimatedCostUsd, '') : 'Cost unknown'}
      description={
        costKnown
          ? 'From the unit prices an operator configured. The token use behind it is below.'
          : 'No unit prices are configured, so no dollar figure is shown. The token use is below.'
      }
      badges={
        <>
          <ProvenanceBadge kind="estimated" size="medium" />
          {labels.simulated ? <ProvenanceBadge kind="simulated" size="medium" /> : null}
          <StateBadge status={budget.status} label={budget.label} title={budget.note} />
          {scope ? (
            <Badge tone="neutral" icon={<BriefcaseIcon />}>
              Case {scope}
            </Badge>
          ) : null}
        </>
      }
      factsSize="large"
      factsLabel="Usage totals"
      facts={[
        {
          id: 'tokens',
          label: 'Tokens used',
          value: <NumberTicker value={totals.totalTokens} format={tokensText} />,
          hint: `${tokensText(totals.promptTokens)} prompt + ${tokensText(totals.completionTokens)} completion`,
        },
        {
          id: 'executions',
          label: 'Model calls',
          value: <NumberTicker value={totals.executions} format={tokensText} />,
          hint: 'Recorded model calls',
        },
        {
          id: 'latency',
          label: 'Average latency',
          value: `${formatNumber(totals.avgLatencyMs, { maximumFractionDigits: 1 })} ms`,
          hint: labels.simulated ? 'Simulated by the offline provider' : 'Per model call',
        },
        {
          id: 'cache-rate',
          label: 'Cache hit rate',
          value: rateText(totals.cacheHitRate, totals.executions),
          hint: `${tokensText(totals.cachedTokens)} tokens served from a cache`,
        },
        {
          id: 'failure-rate',
          label: 'Failure rate',
          value: rateText(totals.failureRate, totals.executions, 1),
          hint: 'Share of calls that did not succeed',
        },
      ]}
      busy={busy}
    >
      <p className={styles.meta}>
        Updated <RelativeTime value={overview.generatedAt} />
      </p>
    </SummaryCard>
  );
}
