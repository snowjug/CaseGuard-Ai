'use client';

import type { CaseComparison, CaseComparisonRow, CaseSummary } from '@caseguard/schemas';
import {
  DataTable,
  EmptyState,
  KeyValueList,
  LoadingSkeleton,
  Notice,
  Panel,
  ProvenanceBadge,
  StatusBadge,
  UiLink,
  formatProbability,
  type DataTableColumn,
} from '@caseguard/ui';
import { Field, Select } from '@fluentui/react-components';
import { ArrowSwapRegular } from '@fluentui/react-icons';
import { keepPreviousData } from '@tanstack/react-query';
import { useMemo } from 'react';
import { PermissionNeeded } from '../../components/common/PermissionNeeded';
import { useApiQuery } from '../../lib/api/hooks';
import { useAuth } from '../../lib/auth/context';
import { useSession } from '../../lib/auth/session';
import { formatNumber } from '../../lib/format';
import { codecs, useUrlState } from '../../lib/url-state';
import { PanelBoundary } from './PanelBoundary';
import { HindsightBadge } from './HindsightBadge';
import { ReadableTable } from './ReadableTable';
import { useInsightStyles } from './styles';

const WITH_CODEC = codecs.optionalString();

/** The change from the first case to the second, as the API computed it, in words that do not say "better". */
export function changeText(deltaPct: number | null): string {
  if (deltaPct === null) return '—';
  if (deltaPct === 0) return 'No change';
  return `${formatNumber(deltaPct, { maximumFractionDigits: 0, signed: true })}% (${deltaPct > 0 ? 'higher' : 'lower'})`;
}

function referenceOf(comparison: CaseComparison, caseId: string): string {
  return comparison.cases.find((item) => item.id === caseId)?.reference ?? caseId;
}

function MetricCell({ row }: { row: CaseComparisonRow }) {
  const styles = useInsightStyles();
  return (
    <div>
      <div>{row.label}</div>
      <div className={styles.meta}>{row.note}</div>
    </div>
  );
}

function buildColumns(comparison: CaseComparison): DataTableColumn<CaseComparisonRow>[] {
  const [first, second] = comparison.cases;
  const valueFor = (row: CaseComparisonRow, caseId: string): string =>
    row.values.find((value) => value.caseId === caseId)?.display ?? '—';
  return [
    {
      id: 'metric',
      header: 'Estimate',
      rowHeader: true,
      cell: (row) => <MetricCell row={row} />,
      sortValue: (row) => row.label,
    },
    ...[first, second].flatMap((item) =>
      item
        ? [
            {
              id: item.id,
              header: item.reference,
              align: 'end' as const,
              cell: (row: CaseComparisonRow) => valueFor(row, item.id),
            },
          ]
        : [],
    ),
    {
      id: 'stronger',
      header: 'Stronger estimate',
      cell: (row) =>
        row.betterCaseId ? (
          <StatusBadge
            status="productive"
            label={referenceOf(comparison, row.betterCaseId)}
            size="small"
          />
        ) : (
          <StatusBadge status="neutral" label="No clear difference" size="small" />
        ),
    },
    {
      id: 'change',
      header: first ? `Change from ${first.reference}` : 'Change',
      align: 'end',
      cell: (row) => changeText(row.deltaPct),
      sortValue: (row) => row.deltaPct,
    },
  ];
}

function ComparisonBody({ comparison }: { comparison: CaseComparison }) {
  const styles = useInsightStyles();
  const columns = useMemo(() => buildColumns(comparison), [comparison]);
  const reuse = comparison.skillReuse;
  return (
    <div className={styles.page}>
      <Panel
        title="What the comparison says"
        description="The narrative the API wrote from the estimates."
        actions={
          <>
            <ProvenanceBadge kind="estimated" />
            {comparison.labels.synthetic ? <ProvenanceBadge kind="synthetic" /> : null}
          </>
        }
      >
        <ul className={styles.bullets}>
          {comparison.narrative.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <Notice variant="model-estimate" compact title="Differences are estimates">
          {comparison.notice}
        </Notice>
      </Panel>
      <Panel
        title="Estimate by estimate"
        description="Both values, which case has the stronger estimate, and how far apart they are."
        help="Each row compares one estimate for the two cases. “Stronger” follows the direction that is better for that estimate (a higher quality score, a lower effort). The change is relative to the first case. None of this shows cause and effect."
      >
        <ReadableTable columns={columns.length}>
          <DataTable
            caption="Comparison of the two cases"
            columns={columns}
            rows={comparison.rows}
            getRowId={(row) => row.metric}
            dense
          />
        </ReadableTable>
      </Panel>
      <Panel
        title="Skill reuse"
        description="Whether a governed skill guided the later investigation."
        help="When a published skill matched the second case and its guided plan was followed, the conformance shows how many of its steps were followed. It describes the process, not the person."
        actions={<ProvenanceBadge kind="estimated" />}
      >
        {reuse === null ? (
          <p className={styles.text}>
            No governed skill was matched and applied across these two cases.
          </p>
        ) : (
          <>
            <UiLink href={`/skills/${encodeURIComponent(reuse.skillId)}`} className={styles.link}>
              {reuse.skillName}
            </UiLink>
            <KeyValueList
              aria-label="Skill reuse"
              layout="inline"
              items={[
                { id: 'version', label: 'Version', value: reuse.skillVersion },
                {
                  id: 'match',
                  label: 'Match score',
                  value: `${formatProbability(reuse.matchScore, 0)} (estimate)`,
                },
                {
                  id: 'conformance',
                  label: 'Plan followed',
                  value:
                    reuse.conformance === null
                      ? 'Not applied yet'
                      : `${formatProbability(reuse.conformance, 0)}: ${reuse.stepsFollowed} of ${reuse.stepsTotal} steps`,
                },
              ]}
            />
          </>
        )}
      </Panel>
    </div>
  );
}

export interface CompareViewProps {
  caseId: string;
  cursorIgnored: boolean;
}

/**
 * The "Compare cases" tab: this case against another analysed case (`compare.cases`, `?with=`). It compares finished
 * cases, so the time cursor does not apply. Estimates only, with the API's own narrative and notice.
 */
export function CompareView({ caseId, cursorIgnored }: CompareViewProps) {
  const styles = useInsightStyles();
  const auth = useAuth();
  const { can } = useSession();
  const [withParam, setWith] = useUrlState('with', WITH_CODEC);
  const cases = useApiQuery(
    'cases.list',
    { query: { limit: 100 } },
    { enabled: auth.status === 'ready', staleTime: 30_000 },
  );
  const others: CaseSummary[] = (cases.data?.items ?? []).filter(
    (item) => item.id !== caseId && item.analysisState === 'analyzed',
  );
  const chosen = withParam ?? others[0]?.id ?? null;
  const allowed = can('analytics:read');
  const query = useApiQuery(
    'compare.cases',
    { query: { caseIds: `${caseId},${chosen ?? ''}` } },
    {
      enabled: auth.status === 'ready' && allowed && chosen !== null,
      placeholderData: keepPreviousData,
    },
  );

  if (!allowed) {
    return (
      <PermissionNeeded
        subject="the case comparison"
        permission="analytics:read"
        grantedTo="Managers and administrators"
      />
    );
  }
  if (cases.isSuccess && others.length === 0) {
    return (
      <EmptyState
        headingLevel={2}
        icon={<ArrowSwapRegular />}
        title="There is no other analysed case to compare with"
        description="Compare needs a second analysed case. Ingest another case, or use a built-in synthetic sample, and analyse it."
      />
    );
  }
  return (
    <div className={styles.page}>
      <div className={styles.hindsight} role="group" aria-label="Retrospective comparison">
        <HindsightBadge />
        <p className={styles.hindsightTitle}>Retrospective comparison: uses the finished cases</p>
        <p className={styles.text}>
          {cursorIgnored
            ? 'The comparison covers whole cases, so it does not follow the time cursor.'
            : 'The comparison covers whole cases, including how they ended.'}
        </p>
      </div>
      <div className={styles.toolbar}>
        <Field label="Compare with" className={styles.field}>
          <Select
            className={styles.select}
            value={chosen ?? ''}
            disabled={others.length === 0}
            onChange={(_event, next) => setWith(next.value || null)}
          >
            {others.map((item) => (
              <option key={item.id} value={item.id}>
                {item.reference} · {item.title}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <PanelBoundary
        query={query}
        subject="The comparison"
        skeleton={<LoadingSkeleton variant="table" count={5} label="Loading the comparison" />}
      >
        {(comparison, meta) => (
          <div
            aria-busy={meta.isRefreshing}
            style={meta.isRefreshing ? { opacity: 0.72 } : undefined}
          >
            <ComparisonBody comparison={comparison} />
          </div>
        )}
      </PanelBoundary>
    </div>
  );
}
