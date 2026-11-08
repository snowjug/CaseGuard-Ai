'use client';

import type { EfficiencyOverview } from '@caseguard/schemas';
import {
  DeltaBar,
  EmptyState,
  HelpButton,
  ProvenanceBadge,
  UiLink,
  formatPercent,
} from '@caseguard/ui';
import { ScaleIcon } from 'lucide-react';
import { caseHref } from '../../lib/deep-links';
import { tokensText } from './model';
import { useUsageStyles } from './styles';

const HELP =
  'Tokens the real investigation used compared with the best valid simulated path from the earliest key decision. Both sides are estimates, and the simulated side is a what-if: nothing was executed. When no key decision has a valid simulated path there is nothing to compare, and the page says so instead of showing a saving of zero.';

export interface PathComparisonSectionProps {
  caseProcess: EfficiencyOverview['caseProcess'];
  /** Reference of the scoped case, when the page is scoped to one. */
  caseReference: string | null;
}

/** The real versus simulated token comparison, always labelled Estimated and Simulated. */
export function PathComparisonSection({ caseProcess, caseReference }: PathComparisonSectionProps) {
  const styles = useUsageStyles();
  const { actualTokens, counterfactualTokens, estimatedSavingsPct, caseId } = caseProcess;
  return (
    <div className={styles.stack}>
      <div className={styles.head}>
        <p className={styles.text}>
          {caseId
            ? `Tokens for ${caseReference ?? 'this case'}: what the investigation used, and what the best simulated path would have needed.`
            : 'Tokens summed over the analysed cases that have a valid simulated path.'}
        </p>
        <ProvenanceBadge kind="estimated" />
        <ProvenanceBadge kind="simulated" />
        <HelpButton label="About this comparison" title="Real versus simulated path">
          {HELP}
        </HelpButton>
      </div>
      {counterfactualTokens === null ? (
        <EmptyState
          compact
          headingLevel={3}
          icon={<ScaleIcon />}
          title="No comparison is available yet"
          description="It needs a key decision with a valid simulated path. Until then there is nothing to compare, so no saving is claimed."
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
      {caseId ? (
        <UiLink href={caseHref(caseId, 'counterfactual')} className={styles.link}>
          Open What if for this case
        </UiLink>
      ) : null}
    </div>
  );
}
