'use client';

import type { CommandCenter } from '@caseguard/schemas';
import { KeyValueList, Notice, Panel, ProvenanceBadge, StatusBadge, UiLink } from '@caseguard/ui';
import { HEALTH_BADGES, PROVIDER_LABELS } from '../../lib/labels';
import { usePanelStyles } from './panel-styles';

export function SystemHealthPanel({ health }: { health: CommandCenter['systemHealth'] }) {
  const styles = usePanelStyles();
  const overall = HEALTH_BADGES[health.status];
  return (
    <Panel
      title="System health"
      description="Dependencies and the AI provider behind this environment."
      footer={
        <UiLink href="/system" className={styles.link}>
          Open System Health
        </UiLink>
      }
    >
      <div className={styles.itemHead}>
        <StatusBadge status={overall.status} label={overall.label} />
        <span className={styles.meta}>
          {health.healthy} healthy · {health.degraded} degraded · {health.unhealthy} unhealthy
        </span>
      </div>
      <KeyValueList
        layout="inline"
        aria-label="AI provider"
        items={[
          {
            id: 'provider',
            label: 'AI provider',
            value: (
              <span className={styles.itemHead}>
                {PROVIDER_LABELS[health.providerKind]}
                {health.providerSimulated ? <ProvenanceBadge kind="simulated" /> : null}
              </span>
            ),
          },
        ]}
      />
      {health.providerSimulated ? (
        <Notice variant="info" compact title={null}>
          Analysis results come from a deterministic, rule-based provider. No external model is
          called, and results are labelled accordingly.
        </Notice>
      ) : null}
    </Panel>
  );
}
