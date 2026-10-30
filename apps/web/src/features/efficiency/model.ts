import type { EfficiencyOverview, ExecutionStatus } from '@caseguard/schemas';
import type { BadgeStatus } from '@caseguard/ui';
import { formatNumber, formatProbability } from '../../lib/format';

/** What an unconfigured limit says. It is never `0`, never an invented default. */
export const NO_LIMIT = 'No limit set';

/** A whole-number token count, or "—" when the value is unknown. */
export function tokensText(value: number | null | undefined): string {
  return formatNumber(value, { maximumFractionDigits: 0 });
}

/** A limit in tokens: "No limit set" when the API sent null. */
export function tokenLimitText(value: number | null): string {
  return value === null ? NO_LIMIT : `${tokensText(value)} tokens`;
}

/** US dollars with cents; unset limits and unknown costs are words, never `$0`. */
export function usdText(value: number | null, whenNull: string): string {
  return value === null
    ? whenNull
    : `$${formatNumber(value, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}

/** A rate (0 to 1) that only means something once something ran; before that it is unknown, not 0%. */
export function rateText(value: number, executions: number, digits = 0): string {
  return executions === 0 ? '—' : formatProbability(value, digits);
}

/** Share of the daily token limit used today, or null when no daily limit is configured. */
export function dailyShare(budgets: EfficiencyOverview['budgets']): number | null {
  const limit = budgets.perDayMaxTokens;
  if (limit === null || limit <= 0) return null;
  return Math.min(1, budgets.consumedToday / limit);
}

export const EXECUTION_STATUS: Record<ExecutionStatus, { label: string; status: BadgeStatus }> = {
  succeeded: { label: 'Succeeded', status: 'productive' },
  cache_hit: { label: 'Cache hit', status: 'productive' },
  failed: { label: 'Failed', status: 'unsupported' },
  timed_out: { label: 'Timed out', status: 'unsupported' },
  cancelled: { label: 'Cancelled', status: 'missing' },
  rejected_by_validation: { label: 'Rejected by validation', status: 'unsupported' },
  circuit_open: { label: 'Circuit open', status: 'uncertain' },
  budget_exceeded: { label: 'Budget exceeded', status: 'uncertain' },
};

export const BREAKER_STATE: Record<
  EfficiencyOverview['circuitBreakers'][number]['state'],
  { label: string; status: BadgeStatus; meaning: string }
> = {
  closed: { label: 'Closed', status: 'productive', meaning: 'Requests flow normally.' },
  open: {
    label: 'Open',
    status: 'unsupported',
    meaning: 'Calls are refused for now because too many failed in a row.',
  },
  half_open: {
    label: 'Half open',
    status: 'uncertain',
    meaning: 'A trial request is allowed to see whether the provider has recovered.',
  },
};

export const RESULT_SOURCE_LABELS = {
  model: 'Model',
  cache: 'Cache',
  deterministic: 'Deterministic engine',
  deterministic_fallback: 'Deterministic fallback',
} as const;
