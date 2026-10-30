'use client';

import { AGENT_LABELS, AGENT_NAMES, type ModelExecutionWithUsage } from '@caseguard/schemas';
import {
  DataTable,
  EmptyState,
  KeyValueList,
  LoadingSkeleton,
  Panel,
  ProvenanceBadge,
  StatusBadge,
  UiLink,
  formatDateTimeUtc,
  type DataTableColumn,
} from '@caseguard/ui';
import { Button, Field, Select } from '@fluentui/react-components';
import { DataBarVerticalRegular } from '@fluentui/react-icons';
import { keepPreviousData } from '@tanstack/react-query';
import { useMemo } from 'react';
import { QueryBoundary } from '../../components/common/QueryBoundary';
import { pagedBoundary, useApiPages } from '../../lib/api/pages';
import { useAuth } from '../../lib/auth/context';
import { caseHref } from '../../lib/deep-links';
import { formatNumber, formatProbability, shortId } from '../../lib/format';
import { codecs, useUrlState } from '../../lib/url-state';
import { ReadableTable } from '../quality/ReadableTable';
import { useInsightStyles } from '../quality/styles';
import { EXECUTION_STATUS, RESULT_SOURCE_LABELS, tokensText, usdText } from './model';

const AGENT_VALUES = ['all', ...AGENT_NAMES] as const;
const AGENT_CODEC = codecs.enumOf(AGENT_VALUES, 'all');
const PAGE_SIZE = 25;

const HELP =
  'Every recorded model call, newest first, with the tokens it used and what the checks on its answer said. The checks (schema, citations, policy and temporal integrity) are run by code on every answer before it is kept. With the deterministic provider the answers come from the knowledge pack and the token counts are simulated estimates.';

const CHECK_LABELS = [
  ['schemaValid', 'Schema'],
  ['citationsValid', 'Citations'],
  ['policyValid', 'Policy'],
  ['temporalValid', 'Temporal integrity'],
] as const;

function failedChecks(row: ModelExecutionWithUsage): string[] {
  return CHECK_LABELS.filter(([key]) => !row.validation[key]).map(([, label]) => label);
}

function ExecutionDetails({ row }: { row: ModelExecutionWithUsage }) {
  const styles = useInsightStyles();
  const usage = row.usage;
  return (
    <details className={styles.details}>
      <summary className={styles.summary}>Details</summary>
      <div className={styles.detailsBody}>
        <KeyValueList
          aria-label={`Details of the ${AGENT_LABELS[row.agent]} call`}
          layout="inline"
          items={[
            { id: 'attempts', label: 'Attempts', value: String(row.attempts) },
            ...(row.retries !== undefined
              ? [{ id: 'retries', label: 'Transport retries', value: String(row.retries) }]
              : []),
            ...(row.repairAttempts !== undefined
              ? [{ id: 'repairs', label: 'Repair attempts', value: String(row.repairAttempts) }]
              : []),
            { id: 'prompt', label: 'Prompt version', value: row.promptVersion },
            ...(row.fallbackReason
              ? [{ id: 'fallback', label: 'Why code answered instead', value: row.fallbackReason }]
              : []),
            ...(row.error ? [{ id: 'error', label: 'Error', value: row.error }] : []),
            ...(row.caseId
              ? [
                  {
                    id: 'case',
                    label: 'Case',
                    value: (
                      <UiLink href={caseHref(row.caseId)} className={styles.link}>
                        Open the case
                      </UiLink>
                    ),
                  },
                ]
              : []),
            ...(row.inputHash
              ? [{ id: 'hash', label: 'Input hash', value: shortId(row.inputHash, 16), mono: true }]
              : []),
          ]}
        />
        <p className={styles.itemTitle}>Checks on the answer</p>
        <ul className={styles.bullets}>
          {CHECK_LABELS.map(([key, label]) => (
            <li key={key}>
              {label}: {row.validation[key] ? 'passed' : 'failed'}
            </li>
          ))}
        </ul>
        {row.validation.issues.length > 0 ? (
          <ul className={styles.bullets} aria-label="Issues found by the checks">
            {row.validation.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        ) : null}
        {usage ? (
          <>
            <p className={styles.itemTitle}>Token usage (estimated)</p>
            <KeyValueList
              aria-label="Token usage of this call"
              layout="inline"
              items={[
                {
                  id: 'before',
                  label: 'Context before',
                  value: `${tokensText(usage.contextTokensBefore)} tokens`,
                },
                {
                  id: 'after',
                  label: 'Context after',
                  value: `${tokensText(usage.contextTokensAfter)} tokens`,
                },
                {
                  id: 'ratio',
                  label: 'Compression',
                  value: formatProbability(usage.compressionRatio, 0),
                },
                { id: 'cache', label: 'Cache', value: usage.cacheHit ? 'Hit' : 'Miss' },
                { id: 'early', label: 'Stopped early', value: usage.earlyStopped ? 'Yes' : 'No' },
                {
                  id: 'saved',
                  label: 'Estimated tokens saved',
                  value: tokensText(usage.estimatedSavingsTokens),
                },
                {
                  id: 'cost',
                  label: 'Estimated cost',
                  value: usdText(usage.estimatedCostUsd, 'Unknown'),
                },
                {
                  id: 'impact',
                  label: 'Estimated effect on quality',
                  value: usage.estimatedQualityImpact.note,
                  hint: usage.estimatedQualityImpact.level.replace('_', ' '),
                },
                ...(usage.tokenSource
                  ? [{ id: 'source', label: 'Token counts', value: usage.tokenSource }]
                  : []),
              ]}
            />
          </>
        ) : null}
      </div>
    </details>
  );
}

const COLUMNS: readonly DataTableColumn<ModelExecutionWithUsage>[] = [
  {
    id: 'completed',
    header: 'Completed',
    rowHeader: true,
    cell: (row) => formatDateTimeUtc(row.completedAt, { seconds: true }),
    sortValue: (row) => row.completedAt,
  },
  {
    id: 'agent',
    header: 'Agent',
    cell: (row) => AGENT_LABELS[row.agent],
    sortValue: (row) => AGENT_LABELS[row.agent],
  },
  {
    id: 'model',
    header: 'Model',
    cell: (row) => (
      <span>
        {row.model}
        {row.simulated ? (
          <>
            {' '}
            <ProvenanceBadge kind="simulated" size="small" />
          </>
        ) : null}
      </span>
    ),
    sortValue: (row) => row.model,
  },
  {
    id: 'status',
    header: 'Status',
    cell: (row) => {
      const status = EXECUTION_STATUS[row.status];
      return <StatusBadge status={status.status} label={status.label} size="small" />;
    },
    sortValue: (row) => EXECUTION_STATUS[row.status].label,
  },
  {
    id: 'tokens',
    header: 'Tokens (in / out)',
    align: 'end',
    cell: (row) =>
      row.usage
        ? `${tokensText(row.usage.promptTokens)} / ${tokensText(row.usage.completionTokens)}`
        : '—',
    sortValue: (row) => row.usage?.totalTokens ?? null,
  },
  {
    id: 'latency',
    header: 'Latency',
    align: 'end',
    cell: (row) => `${formatNumber(row.latencyMs, { maximumFractionDigits: 0 })} ms`,
    sortValue: (row) => row.latencyMs,
  },
  {
    id: 'source',
    header: 'Answer came from',
    cell: (row) => (row.resultSource ? RESULT_SOURCE_LABELS[row.resultSource] : '—'),
    sortValue: (row) => row.resultSource ?? null,
  },
  {
    id: 'checks',
    header: 'Checks',
    cell: (row) => {
      const failed = failedChecks(row);
      return failed.length === 0 ? (
        <StatusBadge status="productive" label="All passed" size="small" />
      ) : (
        <StatusBadge status="unsupported" label={`Failed: ${failed.join(', ')}`} size="small" />
      );
    },
    sortValue: (row) => failedChecks(row).length,
  },
  {
    id: 'details',
    header: 'Details',
    cell: (row) => <ExecutionDetails row={row} />,
  },
];

export interface ExecutionsPanelProps {
  /** Scope of the page: one case, or null for every case. */
  caseId: string | null;
}

/** The model executions table: newest first, filtered by agent, loaded page by page on request. */
export function ExecutionsPanel({ caseId }: ExecutionsPanelProps) {
  const styles = useInsightStyles();
  const auth = useAuth();
  const [agent, setAgent] = useUrlState('agent', AGENT_CODEC);
  const query = useMemo(
    () => ({
      limit: PAGE_SIZE,
      ...(caseId ? { caseId } : {}),
      ...(agent !== 'all' ? { agent } : {}),
    }),
    [caseId, agent],
  );
  const pages = useApiPages(
    'efficiency.executions',
    { query },
    { enabled: auth.status === 'ready', placeholderData: keepPreviousData },
  );
  const rows = useMemo(() => pages.data?.pages.flatMap((page) => page.items) ?? [], [pages.data]);

  return (
    <Panel
      title="Model executions"
      help={HELP}
      description="Every recorded model call, newest first."
      actions={
        <Field label="Agent">
          <Select
            className={styles.select}
            value={agent}
            onChange={(_event, next) => setAgent(next.value as (typeof AGENT_VALUES)[number])}
          >
            <option value="all">All agents</option>
            {AGENT_NAMES.map((name) => (
              <option key={name} value={name}>
                {AGENT_LABELS[name]}
              </option>
            ))}
          </Select>
        </Field>
      }
    >
      <QueryBoundary
        query={pagedBoundary(pages)}
        subject="The model executions"
        skeleton={
          <LoadingSkeleton variant="table" count={4} label="Loading the model executions" />
        }
        isEmpty={(value) => (value.pages[0]?.items.length ?? 0) === 0}
        empty={
          <EmptyState
            compact
            headingLevel={3}
            icon={<DataBarVerticalRegular />}
            title={agent === 'all' ? 'No model executions yet' : 'No executions for this agent'}
            description={
              agent === 'all'
                ? 'They are recorded when a case is analysed.'
                : 'Choose another agent, or clear the filter to see every call.'
            }
            action={
              agent === 'all' ? undefined : (
                <Button appearance="outline" onClick={() => setAgent('all')}>
                  Show every agent
                </Button>
              )
            }
          />
        }
      >
        {() => (
          <>
            <ReadableTable columns={COLUMNS.length}>
              <DataTable
                caption="Model executions"
                columns={COLUMNS}
                rows={rows}
                getRowId={(row) => row.id}
                dense
                defaultSort={null}
              />
            </ReadableTable>
            <div className={styles.actions}>
              <span role="status" aria-live="polite" className={styles.meta}>
                Showing {rows.length} {rows.length === 1 ? 'execution' : 'executions'}
                {pages.hasNextPage ? '; more are available' : ''}.
              </span>
              {pages.hasNextPage ? (
                <Button
                  appearance="outline"
                  disabled={pages.isFetchingNextPage}
                  onClick={() => void pages.fetchNextPage()}
                >
                  {pages.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              ) : null}
            </div>
            {pages.isFetchNextPageError ? (
              <p role="alert" className={styles.text}>
                The next page could not be loaded. Try “Load more” again.
              </p>
            ) : null}
          </>
        )}
      </QueryBoundary>
    </Panel>
  );
}
