'use client';

import type { ProviderStatus } from '@caseguard/schemas';
import {
  Button,
  KeyValueList,
  LoadingSkeleton,
  Notice,
  Panel,
  ProvenanceBadge,
  StatusBadge,
  cg,
  formatDateTimeUtc,
  formatNumber,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { RefreshCwIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useApiQuery } from '../../lib/api/hooks';
import { useAuth } from '../../lib/auth/context';
import { PROVIDER_LABELS } from '../../lib/labels';
import { QueryErrorState } from '../common/QueryErrorState';

const useStyles = makeStyles({
  head: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: cg.space[2] },
  text: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
    overflowWrap: 'anywhere',
  },
  meta: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
});

function healthOf(provider: ProviderStatus) {
  if (provider.healthy === true) return <StatusBadge status="productive" label="Healthy" />;
  if (provider.healthy === false) return <StatusBadge status="unsupported" label="Unhealthy" />;
  return <StatusBadge status="missing" label="Unknown: not checked by a call" />;
}

/**
 * The AI provider as the API reports it, with its validation note in a callout of its own: the note is the honest
 * statement of what has and has not been exercised against a live service.
 */
export function ProviderStatusPanel({
  provider,
  actions,
}: {
  provider: ProviderStatus;
  actions?: ReactNode;
}) {
  const styles = useStyles();
  return (
    <Panel
      title="AI provider"
      description="Which provider runs the analysis, and how far it has been validated."
      help="The deterministic provider is a rule-based engine that runs inside the API: no network call and no language model, so every value it produces is simulated or estimated. Azure OpenAI is implemented, but it has only been validated against mocks in this build. Limits are the effective values after the deployment's own caps."
      actions={actions}
    >
      <div className={styles.head}>
        <strong>{PROVIDER_LABELS[provider.kind]}</strong>
        {provider.simulated ? <ProvenanceBadge kind="simulated" /> : null}
        {healthOf(provider)}
      </div>
      <p className={styles.text}>{provider.detail}</p>
      <Notice variant="info" title="Validation note">
        {provider.validationNote}
      </Notice>
      <KeyValueList
        layout="inline"
        aria-label="AI provider details"
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
        Checked {formatDateTimeUtc(provider.checkedAt, { seconds: true })}
      </p>
    </Panel>
  );
}

/** Fetches `system.provider` and renders the panel; a failure stays inside the panel and offers Retry. */
export function ProviderStatusSection({ enabled = true }: { enabled?: boolean }) {
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
    <ProviderStatusPanel
      provider={query.data}
      actions={
        <Button
          variant="ghost"
          size="sm"
          icon={<RefreshCwIcon />}
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {query.isFetching ? 'Checking…' : 'Check again'}
        </Button>
      }
    />
  );
}
