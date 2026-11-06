import type {
  EfficiencyOverview,
  ExecutionStatus,
  ModelExecutionWithUsage,
} from '@caseguard/schemas';
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

/** Where today's use stands against the budget, in words. Without a daily limit there is nothing to compare with. */
export interface BudgetState {
  label: string;
  status: BadgeStatus;
  /** One sentence for a tooltip. */
  note: string;
}

export function budgetState(budgets: EfficiencyOverview['budgets']): BudgetState {
  const share = dailyShare(budgets);
  if (share === null) {
    return {
      label: 'No daily limit set',
      status: 'neutral',
      note: 'No daily limit is set, so there is nothing to compare today’s use with.',
    };
  }
  if (share >= 1)
    return {
      label: 'Daily limit reached',
      status: 'unsupported',
      note: 'Today’s use has reached the daily token limit.',
    };
  if (share >= 0.8)
    return {
      label: 'Close to the daily limit',
      status: 'uncertain',
      note: 'Today’s use is at least 80% of the daily token limit.',
    };
  return {
    label: 'Within the daily limit',
    status: 'productive',
    note: 'Today’s use is below 80% of the daily token limit.',
  };
}

export const EXECUTION_STATUS: Record<ExecutionStatus, { label: string; status: BadgeStatus }> = {
  succeeded: { label: 'Succeeded', status: 'productive' },
  cache_hit: { label: 'Cache hit', status: 'productive' },
  failed: { label: 'Failed', status: 'unsupported' },
  timed_out: { label: 'Timed out', status: 'unsupported' },
  cancelled: { label: 'Cancelled', status: 'missing' },
  rejected_by_validation: { label: 'Rejected by validation', status: 'unsupported' },
  circuit_open: { label: 'Blocked by a safety limit', status: 'uncertain' },
  budget_exceeded: { label: 'Budget exceeded', status: 'uncertain' },
};

/**
 * The state of a safety limit (a circuit breaker). The plain word is the label; the technical state stays available as
 * a tooltip for anyone who knows the term.
 */
export const BREAKER_STATE: Record<
  EfficiencyOverview['circuitBreakers'][number]['state'],
  { label: string; status: BadgeStatus; meaning: string; technical: string }
> = {
  closed: {
    label: 'Normal',
    status: 'productive',
    meaning: 'Requests flow normally.',
    technical: 'Circuit breaker state: closed',
  },
  open: {
    label: 'Tripped',
    status: 'unsupported',
    meaning: 'Calls are refused for now because too many failed in a row.',
    technical: 'Circuit breaker state: open',
  },
  half_open: {
    label: 'Checking',
    status: 'uncertain',
    meaning: 'A trial request is allowed to see whether the provider has recovered.',
    technical: 'Circuit breaker state: half open',
  },
};

export const RESULT_SOURCE_LABELS = {
  model: 'Model',
  cache: 'Cache',
  deterministic: 'Deterministic engine',
  deterministic_fallback: 'Deterministic fallback',
} as const;

/** The four checks that run on every model answer before it is kept. */
export const CHECK_LABELS = [
  ['schemaValid', 'Schema'],
  ['citationsValid', 'Citations'],
  ['policyValid', 'Policy'],
  ['temporalValid', 'Temporal integrity'],
] as const;

/** The labels of the checks a model call failed (empty when all passed). */
export function failedChecks(row: Pick<ModelExecutionWithUsage, 'validation'>): string[] {
  return CHECK_LABELS.filter(([key]) => !row.validation[key]).map(([, label]) => label);
}
