'use client';

import { AGENT_LABELS, AGENT_NAMES, type ModelExecutionWithUsage } from '@caseguard/schemas';
import {
  Button,
  Drawer,
  EmptyState,
  Field,
  HelpButton,
  LoadingSkeleton,
  ProvenanceBadge,
  RelativeTime,
  Select,
  formatDateTimeUtc,
  formatNumber,
} from '@caseguard/ui';
import { keepPreviousData } from '@tanstack/react-query';
import { ChartNoAxesColumnIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { QueryBoundary } from '../../components/common/QueryBoundary';
import { ResponsiveTable, StateBadge, type ResponsiveColumn } from '../../lib/advanced-view-parts';
import { pagedBoundary, useApiPages } from '../../lib/api/pages';
import { useAuth } from '../../lib/auth/context';
import { codecs, useUrlState } from '../../lib/url-state';
import { ExecutionDetails } from './ExecutionDetails';
import { EXECUTION_STATUS, RESULT_SOURCE_LABELS, failedChecks, tokensText } from './model';
import { useUsageStyles } from './styles';

export const AGENT_VALUES = ['all', ...AGENT_NAMES] as const;
export const AGENT_CODEC = codecs.enumOf(AGENT_VALUES, 'all');
const PAGE_SIZE = 25;

const HELP =
  'Every recorded model call, newest first, with the tokens it used and what the checks on its answer said. The checks (schema, citations, policy and temporal integrity) are run by code on every answer before it is kept. With the deterministic provider the answers come from the knowledge pack and the token counts are simulated estimates.';

export interface ExecutionsSectionProps {
  /** Scope of the page: one case, or null for every case. */
  caseId: string | null;
}

/** The model calls: newest first, filtered by analysis step, loaded page by page on request; details open in a drawer. */
export function ExecutionsSection({ caseId }: ExecutionsSectionProps) {
  const styles = useUsageStyles();
  const auth = useAuth();
  const [agent, setAgent] = useUrlState('agent', AGENT_CODEC);
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
  const selected = rows.find((row) => row.id === selectedId) ?? null;

  const columns: ResponsiveColumn<ModelExecutionWithUsage>[] = [
    {
      id: 'agent',
      header: 'Analysis step',
      card: 'title',
      sortValue: (row) => AGENT_LABELS[row.agent],
      cell: (row) => (
        <span className={styles.cellStack}>
          <span>{AGENT_LABELS[row.agent]}</span>
          <span className={styles.cellMuted}>
            {row.model}
            {row.simulated ? (
              <>
                {' '}
                <ProvenanceBadge kind="simulated" size="small" />
              </>
            ) : null}
          </span>
        </span>
      ),
    },
    {
      id: 'completed',
      header: 'Completed',
      sortValue: (row) => row.completedAt,
      cell: (row) => <RelativeTime value={row.completedAt} />,
    },
    {
      id: 'status',
      header: 'Status',
      sortValue: (row) => EXECUTION_STATUS[row.status].label,
      cell: (row) => {
        const status = EXECUTION_STATUS[row.status];
        return <StateBadge status={status.status} label={status.label} size="sm" />;
      },
    },
    {
      id: 'tokens',
      header: 'Tokens (in / out)',
      align: 'end',
      sortValue: (row) => row.usage?.totalTokens ?? null,
      cell: (row) =>
        row.usage
          ? `${tokensText(row.usage.promptTokens)} / ${tokensText(row.usage.completionTokens)}`
          : '—',
    },
    {
      id: 'latency',
      header: 'Latency',
      align: 'end',
      sortValue: (row) => row.latencyMs,
      cell: (row) => `${formatNumber(row.latencyMs, { maximumFractionDigits: 0 })} ms`,
    },
    {
      id: 'source',
      header: 'Answer came from',
      sortValue: (row) => row.resultSource ?? null,
      cell: (row) => (row.resultSource ? RESULT_SOURCE_LABELS[row.resultSource] : '—'),
    },
    {
      id: 'checks',
      header: 'Checks',
      sortValue: (row) => failedChecks(row).length,
      cell: (row) => {
        const failed = failedChecks(row);
        return failed.length === 0 ? (
          <StateBadge status="productive" label="All passed" size="sm" />
        ) : (
          <StateBadge status="unsupported" label={`Failed: ${failed.join(', ')}`} size="sm" />
        );
      },
    },
    {
      id: 'details',
      header: <span className="cg-sr-only">Details</span>,
      card: 'footer',
      align: 'end',
      cell: (row) => (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Details of the ${AGENT_LABELS[row.agent]} call`}
          onClick={() => {
            setSelectedId(row.id);
            setOpen(true);
          }}
        >
          Details
        </Button>
      ),
    },
  ];

  return (
    <div className={styles.stack}>
      <div className={styles.head}>
        <p className={styles.text}>Every recorded model call, newest first.</p>
        <HelpButton label="About model calls" title="Model calls">
          {HELP}
        </HelpButton>
        <Field label="Analysis step" className={styles.headEnd}>
          <Select
            value={agent}
            onChange={(event) => setAgent(event.target.value as (typeof AGENT_VALUES)[number])}
          >
            <option value="all">All analysis steps</option>
            {AGENT_NAMES.map((name) => (
              <option key={name} value={name}>
                {AGENT_LABELS[name]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <QueryBoundary
        query={pagedBoundary(pages)}
        subject="The model calls"
        skeleton={<LoadingSkeleton variant="table" count={4} label="Loading the model calls" />}
        isEmpty={(value) => (value.pages[0]?.items.length ?? 0) === 0}
        empty={
          <EmptyState
            compact
            headingLevel={3}
            icon={<ChartNoAxesColumnIcon />}
            title={agent === 'all' ? 'No model calls yet' : 'No calls for this analysis step'}
            description={
              agent === 'all'
                ? 'They are recorded when a case is analysed.'
                : 'Choose another analysis step, or clear the filter to see every call.'
            }
            action={
              agent === 'all' ? undefined : (
                <Button variant="secondary" onClick={() => setAgent('all')}>
                  Show every step
                </Button>
              )
            }
          />
        }
      >
        {() => (
          <>
            <ResponsiveTable
              caption="Model calls"
              minWidth={900}
              columns={columns}
              rows={rows}
              getRowId={(row) => row.id}
              dense
              defaultSort={null}
            />
            <div className={styles.footer}>
              <span role="status" aria-live="polite" className={styles.meta}>
                Showing {rows.length} {rows.length === 1 ? 'call' : 'calls'}
                {pages.hasNextPage ? '; more are available' : ''}.
              </span>
              {pages.hasNextPage ? (
                <Button
                  variant="secondary"
                  loading={pages.isFetchingNextPage}
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
      <Drawer
        open={open}
        onOpenChange={setOpen}
        title={selected ? `${AGENT_LABELS[selected.agent]} call` : 'Model call'}
        subtitle={
          selected
            ? `Completed ${formatDateTimeUtc(selected.completedAt, { seconds: true })}`
            : undefined
        }
        size="md"
      >
        {selected ? <ExecutionDetails row={selected} /> : null}
      </Drawer>
    </div>
  );
}
