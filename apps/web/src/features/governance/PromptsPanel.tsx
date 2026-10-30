'use client';

import { AGENT_LABELS, AGENT_NAMES, type PromptVersion } from '@caseguard/schemas';
import {
  CopyButton,
  EmptyState,
  KeyValueList,
  LoadingSkeleton,
  Notice,
  Panel,
  StatusBadge,
  cg,
  formatDateTimeUtc,
  type BadgeStatus,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { DocumentTextRegular } from '@fluentui/react-icons';
import { QueryErrorState } from '../../components/common/QueryErrorState';
import { useApiQuery } from '../../lib/api/hooks';
import { useAuth } from '../../lib/auth/context';
import { ExpandableText } from './ExpandableText';

const useStyles = makeStyles({
  wrap: { display: 'flex', flexDirection: 'column', gap: cg.space[4] },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[4],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  head: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: cg.space[2] },
  hash: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: cg.space[1],
    fontFamily: cg.font.mono,
    fontSize: tokens.fontSizeBase200,
  },
});

const STATUS: Record<PromptVersion['status'], { label: string; status: BadgeStatus }> = {
  active: { label: 'Active', status: 'productive' },
  draft: { label: 'Draft', status: 'uncertain' },
  retired: { label: 'Retired', status: 'missing' },
};

function PromptCard({ prompt }: { prompt: PromptVersion }) {
  const styles = useStyles();
  const status = STATUS[prompt.status];
  return (
    <Panel
      title={`${AGENT_LABELS[prompt.agent]} prompt`}
      actions={
        <span className={styles.head}>
          <strong>Version {prompt.version}</strong>
          <StatusBadge status={status.status} label={status.label} />
        </span>
      }
    >
      <KeyValueList
        columns={2}
        aria-label={`${AGENT_LABELS[prompt.agent]} prompt details`}
        items={[
          {
            id: 'hash',
            label: 'Template hash (SHA-256)',
            value: (
              <span className={styles.hash}>
                {prompt.templateHash.slice(0, 16)}…
                <CopyButton
                  value={prompt.templateHash}
                  label={`Copy the full hash of the ${AGENT_LABELS[prompt.agent]} prompt`}
                />
              </span>
            ),
          },
          { id: 'schema', label: 'Output schema', value: prompt.outputSchemaId, mono: true },
          {
            id: 'by',
            label: 'Created',
            value: `${formatDateTimeUtc(prompt.createdAt)} by ${prompt.createdBy}`,
          },
          { id: 'note', label: 'Change note', value: prompt.changeNote || 'none' },
        ]}
      />
      <ExpandableText text={prompt.template} limit={320} mono />
    </Panel>
  );
}

/**
 * Prompt versions (`governance.prompts`): the exact instructions each analysis agent runs with. They are defined in the
 * application's code, so this view is read-only; every model execution records the hash of the prompt it used.
 */
export function PromptsPanel() {
  const styles = useStyles();
  const auth = useAuth();
  const query = useApiQuery('governance.prompts', undefined, { enabled: auth.status === 'ready' });
  if (query.isPending)
    return <LoadingSkeleton variant="list" count={3} label="Loading prompt versions" />;
  if (query.isError || !query.data) {
    return (
      <QueryErrorState
        error={query.error}
        subject="The prompt versions"
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  const order = (agent: PromptVersion['agent']): number => AGENT_NAMES.indexOf(agent);
  const prompts = [...query.data.items].sort(
    (a, b) =>
      order(a.agent) - order(b.agent) ||
      a.version.localeCompare(b.version, 'en', { numeric: true }),
  );
  return (
    <div className={styles.wrap}>
      <Notice variant="info" title="Read-only">
        Prompt versions are defined in the application&apos;s code and reviewed like any other
        change, so they cannot be edited here. Each model execution records the hash of the prompt
        it used, so any result can be traced to the exact instructions. Prompts tell the models to
        describe process quality and never to rank or judge people.
      </Notice>
      {prompts.length === 0 ? (
        <EmptyState
          headingLevel={2}
          icon={<DocumentTextRegular />}
          title="No prompt versions"
          description="The API returned no prompts. The prompt catalogue is created when the API starts."
        />
      ) : (
        <ul className={styles.list} aria-label="Prompt versions">
          {prompts.map((prompt) => (
            <li key={prompt.id}>
              <PromptCard prompt={prompt} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
