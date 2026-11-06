'use client';

import type { EfficiencyOverview } from '@caseguard/schemas';
import { HelpButton, UiLink } from '@caseguard/ui';
import { ProgressBar } from '@fluentui/react-components';
import { FactList } from '../../lib/advanced-view-parts';
import { NO_LIMIT, dailyShare, tokenLimitText, tokensText, usdText } from './model';
import { useUsageStyles } from './styles';

const HELP =
  'Limits that keep model use predictable. A limit that is not configured says "No limit set": it is never shown as zero and never replaced by a default. The per-request limit is the most input tokens one model call may carry; the token governor refuses a larger call instead of silently cutting it.';

export interface BudgetsSectionProps {
  budgets: EfficiencyOverview['budgets'];
}

/** The configured limits and today's use, with unset limits stated as unset. */
export function BudgetsSection({ budgets }: BudgetsSectionProps) {
  const styles = useUsageStyles();
  const share = dailyShare(budgets);
  return (
    <div className={styles.stack}>
      <div className={styles.head}>
        <p className={styles.text}>
          The most one model call, one case or one day may use, and what has been used today.
        </p>
        <HelpButton label="About budgets and limits" title="Budgets and limits">
          {HELP}
        </HelpButton>
      </div>
      <FactList
        label="Budgets and limits"
        items={[
          {
            id: 'per-request',
            label: 'Per request (input)',
            value: tokenLimitText(budgets.perRequestMaxTokens),
            hint: 'Largest context one model call may carry',
          },
          { id: 'per-case', label: 'Per case', value: tokenLimitText(budgets.perCaseMaxTokens) },
          { id: 'per-day', label: 'Per day', value: tokenLimitText(budgets.perDayMaxTokens) },
          {
            id: 'cost-day',
            label: 'Cost per day',
            value: usdText(budgets.costLimitUsdPerDay, NO_LIMIT),
          },
          {
            id: 'consumed',
            label: 'Used today',
            value: `${tokensText(budgets.consumedToday)} tokens`,
            hint:
              share === null
                ? 'No daily limit is set, so there is nothing to compare it with'
                : undefined,
          },
        ]}
      />
      {share !== null && budgets.perDayMaxTokens !== null ? (
        <div className={styles.stack}>
          <ProgressBar
            value={share}
            max={1}
            aria-label={`Used today: ${Math.round(share * 100)} percent of the daily token limit`}
            color={share >= 1 ? 'error' : share >= 0.8 ? 'warning' : 'brand'}
          />
          <p className={styles.meta}>
            {Math.round(share * 100)}% of the {tokensText(budgets.perDayMaxTokens)} token daily
            limit.
          </p>
        </div>
      ) : null}
      <UiLink href="/governance?tab=model" className={styles.link}>
        Change limits in Settings and audit
      </UiLink>
    </div>
  );
}
