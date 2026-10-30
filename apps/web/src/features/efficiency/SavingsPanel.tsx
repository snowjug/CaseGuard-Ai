'use client';

import type { EfficiencyOverview } from '@caseguard/schemas';
import { KeyValueList, Notice, Panel, ProvenanceBadge, StackedBar } from '@caseguard/ui';
import { useInsightStyles } from '../quality/styles';
import { tokensText } from './model';

const HELP =
  'Estimated tokens the analysis did not have to send or generate: trimming the context to what matters (which includes dropping duplicate notes), reusing a cached answer, and stopping early once more work could not change the result. These are estimates per execution, never measured savings, and each execution also records its own estimated effect on quality.';

export interface SavingsPanelProps {
  savings: EfficiencyOverview['savings'];
}

/** Estimated savings by mechanism, with the honest statement about their effect on quality. */
export function SavingsPanel({ savings }: SavingsPanelProps) {
  const styles = useInsightStyles();
  const rows = [
    {
      key: 'compression',
      label: 'Context compression',
      value: savings.contextCompressionTokens,
      hint: 'Sending only the evidence that matters instead of the whole case text',
    },
    {
      key: 'duplicates',
      label: 'Duplicate-note removal',
      value: savings.duplicateRemovalTokens,
      hint: 'Repeated notes dropped before sending; where it is not tracked separately it is counted within context compression',
    },
    {
      key: 'cache',
      label: 'Cache hits',
      value: savings.cacheHitTokens,
      hint: 'Reusing an earlier answer instead of asking the model again',
    },
    {
      key: 'early-stop',
      label: 'Early stopping',
      value: savings.earlyStopTokens,
      hint: 'Stopping once more work could not change the answer',
    },
  ];
  return (
    <Panel
      title="Estimated savings"
      help={HELP}
      description="Tokens the analysis avoided, by mechanism."
      actions={<ProvenanceBadge kind="estimated" />}
    >
      <p className={styles.tileValue}>
        {tokensText(savings.totalTokens)} tokens
        <span className={styles.meta}> estimated saved in total</span>
      </p>
      {savings.totalTokens > 0 ? (
        <StackedBar
          title="Where the estimated token savings come from"
          valueLabel="Tokens saved"
          valueFormat={(value) => `${tokensText(value)} tokens`}
          segments={rows
            .filter((row) => row.value > 0)
            .map((row) => ({ key: row.key, label: row.label, value: row.value }))}
        />
      ) : null}
      <KeyValueList
        aria-label="Estimated savings by mechanism"
        layout="inline"
        items={rows.map((row) => ({
          id: row.key,
          label: row.label,
          value: `${tokensText(row.value)} tokens`,
          hint: row.hint,
        }))}
      />
      <Notice variant="model-estimate" compact title="Effect on quality">
        {savings.estimatedQualityImpact}
      </Notice>
    </Panel>
  );
}
