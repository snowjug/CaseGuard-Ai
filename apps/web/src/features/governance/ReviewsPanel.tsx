'use client';

import { ROLE_LABELS, type ReviewDecision } from '@caseguard/schemas';
import {
  Button,
  ButtonLink,
  EmptyState,
  Field,
  LoadingSkeleton,
  Panel,
  RelativeTime,
  UiLink,
  cg,
  type BadgeStatus,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { keepPreviousData } from '@tanstack/react-query';
import { ClipboardCheckIcon, RefreshCwIcon } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { QueryErrorState } from '../../components/common/QueryErrorState';
import { StateBadge } from '../../lib/advanced-view-parts';
import { pagedBoundary, useApiPages } from '../../lib/api/pages';
import { useAuth } from '../../lib/auth/context';
import { caseHref } from '../../lib/deep-links';
import { shortId } from '../../lib/format';
import { codecs, useUrlState } from '../../lib/url-state';
import { VirtualRow, useWindowVirtualizer } from '../../lib/virtual-list';
import { CaseFilterSelect } from './CaseFilterSelect';
import { ExpandableText } from './ExpandableText';
import { retryPages, useAutoLoadNext } from './use-auto-load';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  caption: {
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    color: cg.textMuted,
  },
  filters: { display: 'flex', flexWrap: 'wrap', alignItems: 'end', gap: cg.space[3] },
  field: { flex: '1 1 240px', maxWidth: '360px' },
  status: { margin: 0, color: cg.textSecondary, fontSize: tokens.fontSizeBase300 },
  list: { margin: 0, padding: 0, listStyleType: 'none' },
  row: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    padding: `${cg.space[3]} 0`,
    borderBottom: `1px solid ${cg.borderSubtle}`,
    minWidth: 0,
  },
  head: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: cg.space[2] },
  target: { fontWeight: tokens.fontWeightSemibold },
  meta: {
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    color: cg.textSecondary,
    display: 'flex',
    flexWrap: 'wrap',
    gap: `${cg.space[1]} ${cg.space[4]}`,
  },
  label: {
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    color: cg.textMuted,
    fontWeight: tokens.fontWeightSemibold,
  },
  values: {
    display: 'grid',
    gap: cg.space[3],
    gridTemplateColumns: 'minmax(0, 1fr)',
    '@media (min-width: 900px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
  },
  link: { color: cg.textLink },
  more: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[3] },
});

const DECISIONS: Record<ReviewDecision['decision'], { label: string; status: BadgeStatus }> = {
  confirm: { label: 'Confirmed', status: 'productive' },
  approve: { label: 'Approved', status: 'productive' },
  correct: { label: 'Corrected', status: 'uncertain' },
  override: { label: 'Overridden', status: 'uncertain' },
  request_changes: { label: 'Changes requested', status: 'uncertain' },
  reject: { label: 'Rejected', status: 'unsupported' },
  dismiss: { label: 'Dismissed', status: 'neutral' },
};

const TARGETS: Record<ReviewDecision['targetType'], string> = {
  claim: 'Claim',
  fork: 'Key decision',
  counterfactual: 'What-if path',
  warning: 'Quality warning',
  skill: 'Skill',
  skill_version: 'Skill version',
  action_value: 'Action ranking',
  hypothesis: 'Possible cause',
  twin_field: 'Case field',
};

/** Where the decided item lives in the product, or null when there is no single page for it. */
export function reviewTargetHref(
  decision: Pick<ReviewDecision, 'caseId' | 'targetType' | 'targetId'>,
): string | null {
  const { caseId, targetType, targetId } = decision;
  const select = encodeURIComponent(targetId);
  if (targetType === 'skill') return `/skills/${select}`;
  if (!caseId) return null;
  switch (targetType) {
    case 'claim':
      return `${caseHref(caseId, 'evidence')}?sel=${select}`;
    case 'fork':
    case 'counterfactual':
      return `${caseHref(caseId, 'counterfactual')}?sel=${select}`;
    case 'hypothesis':
    case 'action_value':
      return `${caseHref(caseId, 'hypotheses')}?sel=${select}`;
    case 'warning':
      return caseHref(caseId, 'quality');
    case 'twin_field':
      return caseHref(caseId);
    default:
      return null;
  }
}

const compact = (value: unknown): string => {
  if (value === null || value === undefined) return 'none';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
};

const ESTIMATED_ROW = 190;

function ReviewRow({ decision }: { decision: ReviewDecision }) {
  const styles = useStyles();
  const badge = DECISIONS[decision.decision];
  const href = reviewTargetHref(decision);
  const target = `${TARGETS[decision.targetType]} ${shortId(decision.targetId, 22)}`;
  return (
    <article className={styles.row} aria-label={`${badge.label}: ${target}`}>
      <div className={styles.head}>
        <StateBadge status={badge.status} label={badge.label} size="sm" />
        <span className={styles.target}>
          {href ? (
            <UiLink href={href} className={styles.link}>
              {target}
            </UiLink>
          ) : (
            target
          )}
        </span>
      </div>
      <p className={styles.meta}>
        <span>
          {decision.reviewerId} ({ROLE_LABELS[decision.reviewerRole]})
        </span>
        <span>
          <RelativeTime value={decision.decidedAt} />
        </span>
        {decision.caseId ? <span>Case {shortId(decision.caseId, 18)}</span> : null}
      </p>
      <div>
        <p className={styles.label}>Reason</p>
        <ExpandableText text={decision.reason || 'No reason was recorded.'} limit={220} />
      </div>
      <div className={styles.values}>
        <div>
          <p className={styles.label}>Before</p>
          <ExpandableText text={compact(decision.originalValue)} limit={140} mono />
        </div>
        <div>
          <p className={styles.label}>After</p>
          <ExpandableText text={compact(decision.newValue)} limit={140} mono />
        </div>
      </div>
    </article>
  );
}

const CASE_FILTER = codecs.optionalString();

/** Reviewer decisions (`governance.reviews`): every confirmation, correction, rejection and override with its reason. */
export function ReviewsPanel() {
  const styles = useStyles();
  const auth = useAuth();
  const ready = auth.status === 'ready';
  const [caseId, setCaseId] = useUrlState('rcase', CASE_FILTER);
  const pages = useApiPages(
    'governance.reviews',
    { query: { limit: 50, ...(caseId ? { caseId } : {}) } },
    { enabled: ready, placeholderData: keepPreviousData },
  );
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = pages;
  const decisions = useMemo(
    () => pages.data?.pages.flatMap((page) => page.items) ?? [],
    [pages.data],
  );
  const getKey = useCallback((index: number) => decisions[index]?.id ?? String(index), [decisions]);
  const { containerRef, items, totalSize, virtualized, onMeasure } = useWindowVirtualizer({
    count: decisions.length,
    getKey,
    estimateSize: ESTIMATED_ROW,
  });
  const sentinel = useAutoLoadNext(pages);
  const boundary = pagedBoundary(pages);

  return (
    <Panel
      title="Reviewer decisions"
      description="Who confirmed, corrected, rejected or overrode what, and why. The original proposal is always kept."
      help="A reviewer decision never overwrites the original: the model's proposal and the human decision are stored side by side, with the reason. Decisions describe the work product (a claim, a path, a ranking), not the person who produced it."
      actions={
        <Button
          variant="secondary"
          size="sm"
          icon={<RefreshCwIcon />}
          loading={pages.isFetching && !pages.isPending}
          disabledFocusable={!ready || pages.isPending}
          onClick={() => void pages.refetch()}
        >
          {pages.isFetching && !pages.isPending ? 'Refreshing…' : 'Refresh'}
        </Button>
      }
    >
      <div className={styles.stack}>
        <p className={styles.caption}>
          Skill approvals (pilot, validation, publication and rollback) are recorded in the Skills
          library, with who approved each step, and in the audit log as skill events. This list
          holds the review decisions on evidence, key decisions, what-if paths, warnings and
          rankings.
        </p>
        <div className={styles.filters} role="search" aria-label="Filter reviewer decisions">
          <Field label="Case" className={styles.field}>
            <CaseFilterSelect
              value={caseId ?? ''}
              emptyLabel="All cases"
              onChange={(value) => setCaseId(value || null)}
            />
          </Field>
          <Button
            variant="ghost"
            disabledFocusable={caseId === null}
            onClick={() => setCaseId(null)}
          >
            Clear filter
          </Button>
        </div>
        {boundary.isPending ? (
          <LoadingSkeleton variant="list" count={3} label="Loading reviewer decisions" />
        ) : boundary.isError ? (
          <QueryErrorState
            error={boundary.error}
            subject="The reviewer decisions"
            onRetry={() => void pages.refetch()}
            retrying={pages.isFetching}
          />
        ) : (
          <>
            {pages.isError ? (
              <QueryErrorState
                error={pages.error}
                subject={
                  pages.isFetchNextPageError
                    ? 'More reviewer decisions'
                    : 'The latest reviewer decisions'
                }
                compact
                onRetry={() => retryPages(pages)}
                retrying={pages.isFetching}
              />
            ) : null}
            <p className={styles.status} role="status" aria-live="polite">
              {decisions.length === 0
                ? 'No reviewer decisions to show.'
                : `Showing ${decisions.length} ${decisions.length === 1 ? 'decision' : 'decisions'}${hasNextPage ? '; more load as you scroll' : ''}.`}
            </p>
            {decisions.length === 0 ? (
              <EmptyState
                headingLevel={3}
                icon={<ClipboardCheckIcon />}
                title={caseId ? 'No decisions for this case' : 'No reviewer decisions yet'}
                description="Decisions appear when a reviewer confirms or corrects a claim, accepts or rejects a what-if path, or overrides an action ranking."
                action={
                  caseId ? (
                    <Button variant="primary" onClick={() => setCaseId(null)}>
                      Show all cases
                    </Button>
                  ) : (
                    <ButtonLink href="/cases" variant="primary">
                      Open cases
                    </ButtonLink>
                  )
                }
              />
            ) : (
              <ul
                ref={containerRef}
                className={styles.list}
                aria-label={`Reviewer decisions, ${decisions.length} shown`}
                style={virtualized ? { position: 'relative', height: totalSize } : undefined}
              >
                {items.map((item) => {
                  const decision = decisions[item.index];
                  if (!decision) return null;
                  return (
                    <VirtualRow
                      key={item.key}
                      itemKey={item.key}
                      index={item.index}
                      count={decisions.length}
                      start={item.start}
                      virtualized={virtualized}
                      onMeasure={onMeasure}
                    >
                      <ReviewRow decision={decision} />
                    </VirtualRow>
                  );
                })}
              </ul>
            )}
            {hasNextPage ? (
              <div className={styles.more}>
                <div ref={sentinel} aria-hidden="true" />
                <Button
                  variant="secondary"
                  loading={isFetchingNextPage}
                  onClick={() => void fetchNextPage()}
                >
                  {isFetchingNextPage ? 'Loading…' : 'Load more decisions'}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </Panel>
  );
}
