'use client';

import type { EfficiencyOverview } from '@caseguard/schemas';
import { KeyValueList, Panel, UiLink } from '@caseguard/ui';
import { ProgressBar } from '@fluentui/react-components';
import { useInsightStyles } from '../quality/styles';
import { NO_LIMIT, dailyShare, tokenLimitText, tokensText, usdText } from './model';

const HELP =
  'Limits that keep model use predictable. A limit that is not configured says "No limit set": it is never shown as zero and never replaced by a default. The per-request limit is the most input tokens one model call may carry; the token governor refuses a larger call instead of silently cutting it.';

export interface BudgetsPanelProps {
  budgets: EfficiencyOverview['budgets'];
}

/** The configured limits and today's use, with unset limits stated as unset. */
export function BudgetsPanel({ budgets }: BudgetsPanelProps) {
  const styles = useInsightStyles();
  const share = dailyShare(budgets);
  return (
    <Panel
      title="Budgets and limits"
      help={HELP}
      description="What the token governor enforces, and today's consumption."
      footer={
        <UiLink href="/governance" className={styles.link}>
          Change limits in Governance
        </UiLink>
      }
    >
      <KeyValueList
        aria-label="Budgets and limits"
        layout="inline"
        items={[
          {
            id: 'per-request',
            label: 'Per request (input)',
            value: tokenLimitText(budgets.perRequestMaxTokens),
            hint: 'Largest context one model call may carry',
          },
          {
            id: 'per-case',
            label: 'Per case',
            value: tokenLimitText(budgets.perCaseMaxTokens),
          },
          {
            id: 'per-day',
            label: 'Per day',
            value: tokenLimitText(budgets.perDayMaxTokens),
          },
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
        <>
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
        </>
      ) : null}
    </Panel>
  );
}
