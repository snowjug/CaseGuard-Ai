'use client';

import type { ProviderStatus } from '@caseguard/schemas';
import {
  Button,
  LoadingSkeleton,
  Panel,
  ProvenanceBadge,
  RelativeTime,
  formatNumber,
} from '@caseguard/ui';
import { RefreshCwIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { QueryErrorState } from '../../components/common/QueryErrorState';
import { useApiQuery } from '../../lib/api/hooks';
import { FactList, StateBadge } from '../../lib/advanced-view-parts';
import { useAuth } from '../../lib/auth/context';
import { PROVIDER_LABELS } from '../../lib/labels';
import { useSystemStyles } from './styles';

/** What the provider is and how far it has been validated: shown as a help popover wherever the provider appears. */
export const PROVIDER_HELP =
  "The deterministic provider is a rule-based engine that runs inside the API: no network call and no language model, so every value it produces is simulated or estimated. Azure OpenAI is implemented, but it has only been validated against mocks in this build. Limits are the effective values after the deployment's own caps.";

function healthOf(provider: ProviderStatus) {
  if (provider.healthy === true)
    return <StateBadge status="productive" label="Healthy" title="The last check passed." />;
  if (provider.healthy === false)
    return <StateBadge status="unsupported" label="Unhealthy" title="The last check failed." />;
  return (
    <StateBadge
      status="missing"
      label="Unknown: not checked by a call"
      title="No call has been made to this provider, so its health is not known."
    />
  );
}

/**
 * The AI provider as the API reports it. The validation note stays a plain line of its own: it is the honest statement
 * of what has and has not been exercised against a live service.
 */
export function ProviderDetails({ provider }: { provider: ProviderStatus }) {
  const styles = useSystemStyles();
  return (
    <div className={styles.stack}>
      <div className={styles.head}>
        <strong>{PROVIDER_LABELS[provider.kind]}</strong>
        {provider.simulated ? <ProvenanceBadge kind="simulated" /> : null}
        {healthOf(provider)}
      </div>
      <p className={styles.text}>{provider.detail}</p>
      <p className={styles.text}>
        <span className={styles.noteLabel}>Validation note</span>{' '}
        <span>{provider.validationNote}</span>
      </p>
      <FactList
        label="AI provider details"
        items={[
          { id: 'model', label: 'Model', value: provider.model, mono: true },
          { id: 'configured', label: 'Configured', value: provider.configured ? 'Yes' : 'No' },
          {
            id: 'input',
            label: 'Max input tokens',
            value: formatNumber(provider.limits.maxInputTokens),
          },
          {
            id: 'output',
            label: 'Max output tokens',
            value: formatNumber(provider.limits.maxOutputTokens),
          },
          {
            id: 'timeout',
            label: 'Timeout',
            value: `${formatNumber(provider.limits.timeoutMs / 1000)} s`,
          },
          { id: 'retries', label: 'Max retries', value: formatNumber(provider.limits.maxRetries) },
        ]}
      />
      <p className={styles.meta}>
        Checked <RelativeTime value={provider.checkedAt} />
      </p>
    </div>
  );
}

/** The "Check again" control that re-asks the API for the provider's status. */
export function CheckAgainButton({
  checking,
  onClick,
}: {
  checking: boolean;
  onClick: () => void;
}) {
  return (
    <Button variant="ghost" size="sm" icon={<RefreshCwIcon />} loading={checking} onClick={onClick}>
      {checking ? 'Checking…' : 'Check again'}
    </Button>
  );
}

/** Fetches `system.provider` and shows it in a panel; a failure stays inside the panel and offers Retry. */
export function ProviderSection({
  enabled = true,
  extraActions,
}: {
  enabled?: boolean;
  /** Controls shown beside "Check again" (a link to the page that shows the whole picture). */
  extraActions?: ReactNode;
}) {
  const auth = useAuth();
  const query = useApiQuery('system.provider', undefined, {
    enabled: enabled && auth.status === 'ready',
  });
  if (query.isPending)
    return <LoadingSkeleton variant="card" count={1} label="Loading the AI provider status" />;
  if (query.isError || !query.data) {
    return (
      <QueryErrorState
        error={query.error}
        subject="The AI provider status"
        compact
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  return (
    <Panel
      title="AI provider"
      description="Which provider runs the analysis, and how far it has been validated."
      help={PROVIDER_HELP}
      actions={
        <>
          {extraActions}
          <CheckAgainButton checking={query.isFetching} onClick={() => void query.refetch()} />
        </>
      }
    >
      <ProviderDetails provider={query.data} />
    </Panel>
  );
}
