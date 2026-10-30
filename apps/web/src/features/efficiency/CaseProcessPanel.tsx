'use client';

import type { EfficiencyOverview } from '@caseguard/schemas';
import { DeltaBar, EmptyState, Panel, ProvenanceBadge, UiLink } from '@caseguard/ui';
import { ScalesRegular } from '@fluentui/react-icons';
import { caseHref } from '../../lib/deep-links';
import { formatPercent } from '../../lib/format';
import { useInsightStyles } from '../quality/styles';
import { tokensText } from './model';

const HELP =
  'Tokens the real investigation used compared with the best valid simulated path from the earliest decision fork. Both sides are estimates, and the simulated side is a what-if: nothing was executed. When no decision fork has a valid simulated path there is nothing to compare, and the page says so instead of showing a saving of zero.';

export interface CaseProcessPanelProps {
  caseProcess: EfficiencyOverview['caseProcess'];
  /** Reference of the scoped case, when the page is scoped to one. */
  caseReference: string | null;
}

/** The real versus simulated token comparison, always labelled Estimated and Simulated. */
export function CaseProcessPanel({ caseProcess, caseReference }: CaseProcessPanelProps) {
  const styles = useInsightStyles();
  const { actualTokens, counterfactualTokens, estimatedSavingsPct, caseId } = caseProcess;
  return (
    <Panel
      title="Real process versus a simulated better path"
      help={HELP}
      description={
        caseId
          ? `Tokens for ${caseReference ?? 'this case'}: what the investigation used, and what the best simulated path would have needed.`
          : 'Tokens summed over the analysed cases that have a valid simulated path.'
      }
      actions={
        <>
          <ProvenanceBadge kind="estimated" />
          <ProvenanceBadge kind="simulated" />
        </>
      }
      footer={
        caseId ? (
          <UiLink href={caseHref(caseId, 'counterfactual')} className={styles.link}>
            Open the Counterfactual Lab for this case
          </UiLink>
        ) : undefined
      }
    >
      {counterfactualTokens === null ? (
        <EmptyState
          compact
          headingLevel={3}
          icon={<ScalesRegular />}
          title="No comparison is available yet"
          description="It needs a decision fork with a valid simulated path. Until then there is nothing to compare, so no saving is claimed."
        />
      ) : (
        <>
          <DeltaBar
            label="Tokens used by the investigation"
            actual={actualTokens}
            counterfactual={counterfactualTokens}
            better="lower"
            format={(value) => `${tokensText(value)} tokens`}
            actualLabel="Real path"
            counterfactualLabel="Simulated path"
          />
          <p className={styles.text}>
            <span className={styles.strong}>
              Estimated saving:{' '}
              {estimatedSavingsPct === null
                ? 'not available'
                : formatPercent(estimatedSavingsPct, 1)}
            </span>
            . This is an estimate from a simulated path, not a measured result.
          </p>
        </>
      )}
    </Panel>
  );
}
