'use client';

import type { EfficiencyOverview } from '@caseguard/schemas';
import { EmptyState, HelpButton, RelativeTime } from '@caseguard/ui';
import { UnplugIcon } from 'lucide-react';
import { StateBadge } from '../../lib/advanced-view-parts';
import { BREAKER_STATE } from './model';
import { useUsageStyles } from './styles';

const HELP =
  'A safety limit (technically a circuit breaker) stops calls to a model provider for a while after several failures in a row, so a failing service is not hammered and the analysis fails fast instead of hanging. Normal means calls flow, tripped means they are refused, checking means one trial call is allowed.';

export interface SafetyLimitsSectionProps {
  breakers: EfficiencyOverview['circuitBreakers'];
  /** True when the deterministic offline provider is in use (it makes no remote calls). */
  simulated: boolean;
}

/** The provider safety limits; with none in use it says why instead of showing an empty box. */
export function SafetyLimitsSection({ breakers, simulated }: SafetyLimitsSectionProps) {
  const styles = useUsageStyles();
  return (
    <div className={styles.stack}>
      <div className={styles.head}>
        <p className={styles.text}>Protection against a failing model provider.</p>
        <HelpButton label="About safety limits" title="Safety limits">
          {HELP}
        </HelpButton>
      </div>
      {breakers.length === 0 ? (
        <EmptyState
          compact
          headingLevel={3}
          icon={<UnplugIcon />}
          title="No safety limit is in use"
          description={
            simulated
              ? 'The deterministic provider makes no remote calls, so there is nothing to break. When a live provider is configured its safety limit appears here with its state.'
              : 'No safety limit state was reported for the configured provider.'
          }
        />
      ) : (
        <ul className={styles.list}>
          {breakers.map((breaker) => {
            const state = BREAKER_STATE[breaker.state];
            return (
              <li key={breaker.name} className={styles.item}>
                <div className={styles.head}>
                  <h3 className={styles.itemTitle}>{breaker.name}</h3>
                  <StateBadge
                    status={state.status}
                    label={state.label}
                    title={state.technical}
                    size="sm"
                  />
                </div>
                <p className={styles.text}>{state.meaning}</p>
                <p className={styles.meta}>
                  {breaker.consecutiveFailures} consecutive{' '}
                  {breaker.consecutiveFailures === 1 ? 'failure' : 'failures'}
                  {breaker.openedAt ? (
                    <>
                      {' '}
                      · tripped <RelativeTime value={breaker.openedAt} />
                    </>
                  ) : null}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
