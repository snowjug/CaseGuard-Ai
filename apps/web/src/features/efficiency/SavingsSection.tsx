'use client';

import type { EfficiencyOverview } from '@caseguard/schemas';
import { HelpButton, ProvenanceBadge, StackedBar } from '@caseguard/ui';
import { FactList } from '../../lib/advanced-view-parts';
import { tokensText } from './model';
import { useUsageStyles } from './styles';

const HELP =
  'Estimated tokens the analysis did not have to send or generate: trimming the context to what matters (which includes dropping duplicate notes), reusing a cached answer, and stopping early once more work could not change the result. These are estimates per call, never measured savings, and each call also records its own estimated effect on quality.';

export interface SavingsSectionProps {
  savings: EfficiencyOverview['savings'];
}

/** Estimated savings by mechanism, with the honest statement about their effect on quality. */
export function SavingsSection({ savings }: SavingsSectionProps) {
  const styles = useUsageStyles();
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
    <div className={styles.stack}>
      <div className={styles.head}>
        <p className={styles.figure}>
          {tokensText(savings.totalTokens)} tokens
          <span className={styles.meta}> estimated saved in total</span>
        </p>
        <ProvenanceBadge kind="estimated" />
        <HelpButton label="About estimated savings" title="Estimated savings">
          {HELP}
        </HelpButton>
      </div>
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
      <FactList
        label="Estimated savings by mechanism"
        items={rows.map((row) => ({
          id: row.key,
          label: row.label,
          value: `${tokensText(row.value)} tokens`,
          hint: row.hint,
        }))}
      />
      <p className={styles.text}>
        <span className={styles.strong}>Effect on quality.</span> {savings.estimatedQualityImpact}
      </p>
    </div>
  );
}
