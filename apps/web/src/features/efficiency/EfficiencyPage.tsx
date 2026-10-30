'use client';

import { Notice, PageHeader, ProvenanceBadge, formatTimeUtc } from '@caseguard/ui';
import { Button, Field, Select, mergeClasses } from '@fluentui/react-components';
import { ArrowSyncRegular } from '@fluentui/react-icons';
import { keepPreviousData } from '@tanstack/react-query';
import { PermissionGate } from '../../components/common/PermissionGate';
import { QueryBoundary } from '../../components/common/QueryBoundary';
import { useApiQuery } from '../../lib/api/hooks';
import { useAuth } from '../../lib/auth/context';
import { codecs, useUrlState } from '../../lib/url-state';
import { useInsightStyles } from '../quality/styles';
import { AgentsPanel } from './AgentsPanel';
import { BreakersPanel } from './BreakersPanel';
import { BudgetsPanel } from './BudgetsPanel';
import { CaseProcessPanel } from './CaseProcessPanel';
import { ExecutionsPanel } from './ExecutionsPanel';
import { SavingsPanel } from './SavingsPanel';
import { EfficiencySkeleton } from './Skeleton';
import { TotalsPanel } from './TotalsPanel';

const CASE_CODEC = codecs.optionalString();

const PAGE_HELP = (
  <>
    <p>
      The Efficiency Monitor shows how much model work the analysis used (tokens, time and calls),
      what was saved by sending less or reusing answers, and which limits apply.
    </p>
    <p>
      Every figure is an estimate. With the deterministic offline provider the token counts and
      latencies are simulated and say so; no model usage from Azure OpenAI is shown unless that
      provider is configured and was actually used. Cost stays unknown until unit prices are
      configured.
    </p>
    <p>
      Limits that are not configured read “No limit set”, never zero. Use the scope to look at one
      case; the real-versus-simulated comparison compares tokens, not people.
    </p>
  </>
);

function EfficiencyContent() {
  const styles = useInsightStyles();
  const auth = useAuth();
  const [caseId, setCaseId] = useUrlState('case', CASE_CODEC);
  const cases = useApiQuery(
    'cases.list',
    { query: { limit: 100 } },
    { enabled: auth.status === 'ready', staleTime: 30_000 },
  );
  const query = useApiQuery(
    'efficiency.overview',
    { query: caseId ? { caseId } : {} },
    { enabled: auth.status === 'ready', placeholderData: keepPreviousData },
  );
  const items = cases.data?.items ?? [];
  const reference = items.find((item) => item.id === caseId)?.reference ?? null;

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <Field label="Scope" className={styles.field}>
          <Select
            className={styles.select}
            value={caseId ?? ''}
            onChange={(_event, next) => setCaseId(next.value === '' ? null : next.value)}
          >
            <option value="">All cases</option>
            {caseId && !items.some((item) => item.id === caseId) ? (
              <option value={caseId}>{caseId}</option>
            ) : null}
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.reference} · {item.title}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          appearance="outline"
          icon={<ArrowSyncRegular />}
          disabled={auth.status !== 'ready' || query.isFetching}
          onClick={() => void query.refetch()}
        >
          {query.isFetching && !query.isPending ? 'Refreshing…' : 'Refresh'}
        </Button>
        {query.data ? (
          <span className={styles.meta}>Updated {formatTimeUtc(query.data.generatedAt)}</span>
        ) : null}
      </div>
      <QueryBoundary
        query={query}
        subject="The Efficiency Monitor"
        skeleton={<EfficiencySkeleton />}
      >
        {(data, meta) => {
          const hasUsage = data.totals.executions > 0;
          return (
            <div
              className={mergeClasses(styles.page, meta.isRefreshing && styles.busy)}
              aria-busy={meta.isRefreshing}
            >
              {data.notes.length > 0 ? (
                <Notice variant="model-estimate" title="How to read these figures">
                  <ul className={styles.bullets}>
                    {data.notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                </Notice>
              ) : null}
              <TotalsPanel totals={data.totals} simulated={data.labels.simulated} />
              {hasUsage ? (
                <div className={styles.band}>
                  <SavingsPanel savings={data.savings} />
                  <CaseProcessPanel caseProcess={data.caseProcess} caseReference={reference} />
                </div>
              ) : null}
              <div className={styles.band}>
                <BudgetsPanel budgets={data.budgets} />
                <BreakersPanel breakers={data.circuitBreakers} simulated={data.labels.simulated} />
              </div>
              {hasUsage ? <AgentsPanel byAgent={data.byAgent} byModel={data.byModel} /> : null}
              {hasUsage ? <ExecutionsPanel caseId={caseId} /> : null}
            </div>
          );
        }}
      </QueryBoundary>
    </div>
  );
}

/**
 * Efficiency Monitor (`/efficiency`): token and compute telemetry, estimated savings, budgets (unset limits say so),
 * circuit breakers, the real-versus-simulated token comparison and the model executions table. Everything is labelled
 * Estimated, and Simulated when the deterministic provider produced it. `?case=` scopes the page to one case and
 * `?agent=` filters the executions.
 */
export function EfficiencyPage() {
  return (
    <>
      <PageHeader
        title="Efficiency Monitor"
        description="Token and compute use of the analysis, what was saved, and the limits that apply."
        help={PAGE_HELP}
        meta={<ProvenanceBadge kind="estimated" />}
      />
      <PermissionGate
        permission="telemetry:read"
        subject="the Efficiency Monitor"
        grantedTo="Engineers, reviewers, managers and administrators"
        skeleton={<EfficiencySkeleton />}
      >
        <EfficiencyContent />
      </PermissionGate>
    </>
  );
}
