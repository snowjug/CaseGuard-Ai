'use client';

import { AGENT_LABELS, AGENT_NAMES, type PromptVersion } from '@caseguard/schemas';
import {
  Accordion,
  AccordionItem,
  Badge,
  CopyButton,
  EmptyState,
  HelpButton,
  LoadingSkeleton,
  Panel,
  RelativeTime,
  cg,
  type BadgeStatus,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { FileTextIcon, LockIcon } from 'lucide-react';
import { QueryErrorState } from '../../components/common/QueryErrorState';
import { FactList, StateBadge } from '../../lib/advanced-view-parts';
import { useApiQuery } from '../../lib/api/hooks';
import { useAuth } from '../../lib/auth/context';
import { ExpandableText } from './ExpandableText';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  note: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: cg.space[2] },
  noteText: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
  },
  hash: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: cg.space[1],
    fontFamily: cg.font.mono,
    fontSize: tokens.fontSizeBase200,
  },
  body: { display: 'flex', flexDirection: 'column', gap: cg.space[4] },
});

const STATUS: Record<
  PromptVersion['status'],
  { label: string; status: BadgeStatus; title: string }
> = {
  active: { label: 'Active', status: 'productive', title: 'The version the analysis uses now.' },
  draft: { label: 'Draft', status: 'uncertain', title: 'Not in use yet.' },
  retired: { label: 'Retired', status: 'missing', title: 'No longer used.' },
};

function PromptDetails({ prompt }: { prompt: PromptVersion }) {
  const styles = useStyles();
  const label = AGENT_LABELS[prompt.agent];
  return (
    <div className={styles.body}>
      <FactList
        label={`${label} prompt details`}
        items={[
          {
            id: 'hash',
            label: 'Template hash (SHA-256)',
            value: (
              <span className={styles.hash}>
                {prompt.templateHash.slice(0, 16)}…
                <CopyButton
                  value={prompt.templateHash}
                  label={`Copy the full hash of the ${label} prompt`}
                />
              </span>
            ),
          },
          { id: 'schema', label: 'Output schema', value: prompt.outputSchemaId, mono: true },
          {
            id: 'by',
            label: 'Created',
            value: (
              <>
                <RelativeTime value={prompt.createdAt} /> by {prompt.createdBy}
              </>
            ),
          },
          { id: 'note', label: 'Change note', value: prompt.changeNote || 'none' },
        ]}
      />
      <ExpandableText text={prompt.template} limit={320} mono />
    </div>
  );
}

/**
 * Prompt versions (`governance.prompts`): the exact instructions each analysis step runs with. They are defined in the
 * application's code, so this view is read-only; every model call records the hash of the prompt it used.
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
    <Panel
      title="Prompt versions"
      description="The exact instructions each analysis step runs with."
    >
      <div className={styles.stack}>
        <div className={styles.note}>
          <Badge tone="neutral" icon={<LockIcon />} title="Prompts are changed in code, not here.">
            Read-only
          </Badge>
          <p className={styles.noteText}>
            Prompt versions are defined in the application&apos;s code and reviewed like any other
            change, so they cannot be edited here.
          </p>
          <HelpButton label="About prompt versions" title="Prompt versions">
            Each model call records the hash of the prompt it used, so any result can be traced to
            the exact instructions. Prompts tell the models to describe process quality and never to
            rank or judge people.
          </HelpButton>
        </div>
        {prompts.length === 0 ? (
          <EmptyState
            headingLevel={3}
            icon={<FileTextIcon />}
            title="No prompt versions"
            description="The API returned no prompts. The prompt catalogue is created when the API starts."
          />
        ) : (
          <Accordion>
            {prompts.map((prompt, index) => {
              const status = STATUS[prompt.status];
              return (
                <AccordionItem
                  key={prompt.id}
                  headingLevel={3}
                  icon={<FileTextIcon />}
                  title={`${AGENT_LABELS[prompt.agent]} prompt`}
                  subtitle={`Version ${prompt.version}`}
                  badge={
                    <StateBadge status={status.status} label={status.label} title={status.title} />
                  }
                  defaultOpen={index === 0}
                >
                  <PromptDetails prompt={prompt} />
                </AccordionItem>
              );
            })}
          </Accordion>
        )}
      </div>
    </Panel>
  );
}
