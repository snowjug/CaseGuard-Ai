'use client';

import type { EfficiencyOverview } from '@caseguard/schemas';
import { EmptyState, Panel, StatusBadge, formatDateTimeUtc } from '@caseguard/ui';
import { PlugDisconnectedRegular } from '@fluentui/react-icons';
import { useInsightStyles } from '../quality/styles';
import { BREAKER_STATE } from './model';

const HELP =
  'A circuit breaker stops calls to a model provider for a while after several failures in a row, so a failing service is not hammered and the analysis fails fast instead of hanging. Closed means calls flow, open means they are refused, half open means one trial call is allowed.';

export interface BreakersPanelProps {
  breakers: EfficiencyOverview['circuitBreakers'];
  /** True when the deterministic offline provider is in use (it makes no remote calls). */
  simulated: boolean;
}

/** The provider circuit breakers; with none in use it says why instead of showing an empty box. */
export function BreakersPanel({ breakers, simulated }: BreakersPanelProps) {
  const styles = useInsightStyles();
  return (
    <Panel
      title="Circuit breakers"
      help={HELP}
      description="Protection against a failing model provider."
    >
      {breakers.length === 0 ? (
        <EmptyState
          compact
          headingLevel={3}
          icon={<PlugDisconnectedRegular />}
          title="No circuit breaker is in use"
          description={
            simulated
              ? 'The deterministic provider makes no remote calls, so there is nothing to break. When a live provider is configured its breaker appears here with its state.'
              : 'No breaker state was reported for the configured provider.'
          }
        />
      ) : (
        <ul className={styles.list}>
          {breakers.map((breaker) => {
            const state = BREAKER_STATE[breaker.state];
            return (
              <li key={breaker.name} className={styles.item}>
                <div className={styles.itemHead}>
                  <h3 className={styles.itemTitle}>{breaker.name}</h3>
                  <StatusBadge status={state.status} label={state.label} size="small" />
                </div>
                <p className={styles.text}>{state.meaning}</p>
                <p className={styles.meta}>
                  {breaker.consecutiveFailures} consecutive{' '}
                  {breaker.consecutiveFailures === 1 ? 'failure' : 'failures'}
                  {breaker.openedAt ? ` · opened ${formatDateTimeUtc(breaker.openedAt)}` : ''}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
