'use client';

import { ROLE_LABELS, type AuditEvent } from '@caseguard/schemas';
import {
  Button,
  CopyButton,
  EmptyState,
  Field,
  Input,
  LoadingSkeleton,
  Panel,
  RelativeTime,
  Select,
  UiLink,
  cg,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { keepPreviousData } from '@tanstack/react-query';
import { HistoryIcon, RefreshCwIcon, ShieldCheckIcon } from 'lucide-react';
import { useCallback, useId, useMemo } from 'react';
import { QueryErrorState } from '../../components/common/QueryErrorState';
import { StateBadge } from '../../lib/advanced-view-parts';
import { pagedBoundary, useApiPages } from '../../lib/api/pages';
import { useAuth } from '../../lib/auth/context';
import { caseHref } from '../../lib/deep-links';
import { shortId } from '../../lib/format';
import { useDebouncedValue } from '../../lib/use-debounced-value';
import { useUrlStates, useUrlTextState } from '../../lib/url-state';
import { VirtualRow, useWindowVirtualizer } from '../../lib/virtual-list';
import {
  AUDIT_FILTERS,
  KNOWN_AUDIT_ACTIONS,
  OUTCOME_FILTERS,
  OUTCOME_LABELS,
  activeAuditFilters,
  auditQuery,
  type AuditFilterValues,
} from './audit-filters';
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
  filters: {
    display: 'grid',
    alignItems: 'end',
    gap: `${cg.space[3]} ${cg.space[4]}`,
    gridTemplateColumns: 'minmax(0, 1fr)',
    '@media (min-width: 640px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
    '@media (min-width: 1100px)': { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' },
  },
  filterActions: { display: 'flex', alignItems: 'center', gap: cg.space[2] },
  status: { margin: 0, color: cg.textSecondary, fontSize: tokens.fontSizeBase300 },
  list: { margin: 0, padding: 0, listStyleType: 'none' },
  row: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    padding: `${cg.space[3]} 0`,
    borderBottom: `1px solid ${cg.borderSubtle}`,
    minWidth: 0,
  },
  head: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: cg.space[2] },
  seq: {
    fontVariantNumeric: 'tabular-nums',
    color: cg.textMuted,
    fontSize: tokens.fontSizeBase200,
  },
  action: {
    fontFamily: cg.font.mono,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    overflowWrap: 'anywhere',
  },
  meta: {
    margin: 0,
    display: 'flex',
    flexWrap: 'wrap',
    gap: `${cg.space[1]} ${cg.space[4]}`,
    fontSize: tokens.fontSizeBase200,
    color: cg.textSecondary,
  },
  hashes: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${cg.space[1]} ${cg.space[3]}`,
    fontFamily: cg.font.mono,
    fontSize: tokens.fontSizeBase200,
    color: cg.textMuted,
  },
  chip: { display: 'inline-flex', alignItems: 'center', gap: '2px' },
  link: { color: cg.textLink },
  more: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[3] },
});

/** Estimated height of an audit row before it is measured. */
const ESTIMATED_ROW = 132;

const OUTCOME_BADGE = {
  success: { status: 'productive', label: 'Success', title: 'The action went through.' },
  denied: { status: 'unsupported', label: 'Denied', title: 'The action was refused.' },
  failure: { status: 'unsupported', label: 'Failure', title: 'The action failed.' },
} as const;

function AuditRow({ event }: { event: AuditEvent }) {
  const styles = useStyles();
  const outcome = OUTCOME_BADGE[event.outcome];
  const role =
    event.actorRole === 'system'
      ? 'System'
      : event.actorRole === 'anonymous'
        ? 'Anonymous'
        : ROLE_LABELS[event.actorRole];
  const hasDetails = Object.keys(event.details).length > 0;
  return (
    <article className={styles.row} aria-label={`Audit event ${event.sequence}: ${event.action}`}>
      <div className={styles.head}>
        <span className={styles.seq}>#{event.sequence}</span>
        <span className={styles.action}>{event.action}</span>
        <StateBadge status={outcome.status} label={outcome.label} title={outcome.title} size="sm" />
        <span className={styles.seq}>
          <RelativeTime value={event.occurredAt} />
        </span>
      </div>
      <p className={styles.meta}>
        <span>
          Actor: {event.actorId} ({role})
        </span>
        <span>
          Target: {event.targetType}
          {event.targetId ? ` · ${event.targetId}` : ''}
        </span>
        {event.caseId ? (
          <span>
            Case:{' '}
            <UiLink href={caseHref(event.caseId)} className={styles.link}>
              {shortId(event.caseId, 18)}
            </UiLink>
          </span>
        ) : null}
      </p>
      {hasDetails ? (
        <ExpandableText text={JSON.stringify(event.details, null, 2)} limit={160} mono />
      ) : null}
      <div className={styles.hashes}>
        <span className={styles.chip}>
          hash {event.hash.slice(0, 10)}…
          <CopyButton value={event.hash} label={`Copy the hash of event ${event.sequence}`} />
        </span>
        <span className={styles.chip}>
          previous {event.prevHash.slice(0, 10)}…
          <CopyButton
            value={event.prevHash}
            label={`Copy the previous hash of event ${event.sequence}`}
          />
        </span>
        <span className={styles.chip}>
          {event.correlationId}
          <CopyButton
            value={event.correlationId}
            label={`Copy the reference of event ${event.sequence}`}
          />
        </span>
      </div>
    </article>
  );
}

/**
 * Audit log (`governance.audit`): append-only, hash-chained events, newest first, with filters in the URL and a
 * virtualised list that loads more as you scroll. Reading the log is itself audited, so nothing here refreshes by itself.
 * The chain check sits in the summary at the top of the page.
 */
export function AuditPanel() {
  const styles = useStyles();
  const auth = useAuth();
  const ready = auth.status === 'ready';
  const [filters, update] = useUrlStates(AUDIT_FILTERS);
  // The text and date filters are typed, so each lives in its field and reaches the URL from there (see
  // `useUrlTextState`); a date is complete when it changes, so it is written at once.
  const actionField = useUrlTextState('act', AUDIT_FILTERS.act);
  const actorField = useUrlTextState('actor', AUDIT_FILTERS.actor);
  const fromField = useUrlTextState('afrom', AUDIT_FILTERS.afrom, { delayMs: 0 });
  const toField = useUrlTextState('ato', AUDIT_FILTERS.ato, { delayMs: 0 });
  const listId = useId();
  const values: AuditFilterValues = {
    ...filters,
    act: actionField.value,
    actor: actorField.value,
    afrom: fromField.value,
    ato: toField.value,
  };
  // Text filters query only after typing pauses, so each keystroke is not an audited read.
  const debouncedAction = useDebouncedValue(values.act, 400);
  const debouncedActor = useDebouncedValue(values.actor, 400);
  const pages = useApiPages(
    'governance.audit',
    { query: auditQuery({ ...values, act: debouncedAction, actor: debouncedActor }) },
    { enabled: ready, placeholderData: keepPreviousData },
  );
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = pages;
  const events = useMemo(() => pages.data?.pages.flatMap((page) => page.items) ?? [], [pages.data]);
  const total = pages.data?.pages[0]?.total;

  const getKey = useCallback((index: number) => events[index]?.id ?? String(index), [events]);
  const { containerRef, items, totalSize, virtualized, onMeasure } = useWindowVirtualizer({
    count: events.length,
    getKey,
    estimateSize: ESTIMATED_ROW,
  });
  const sentinel = useAutoLoadNext(pages);

  const active = activeAuditFilters(values);
  const clear = (): void => {
    for (const field of [actionField, actorField, fromField, toField]) field.set('');
    update({ acase: null, aout: 'all' });
  };
  const boundary = pagedBoundary(pages);
  const suggestions = useMemo(
    () => [...new Set([...KNOWN_AUDIT_ACTIONS, ...events.map((event) => event.action)])].sort(),
    [events],
  );

  return (
    <Panel
      title="Audit events"
      description="Newest first. Filters narrow the list; the action and actor filters match exactly."
      help="The audit log records who did what, to what, when and with what outcome: sign-ins that were refused, settings changed, roles assigned, exports, reviews, skill approvals and demo resets. Details hold ids and counters, never case text or secrets. The log is append-only."
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
          Reading the audit log is itself recorded in the audit log, so this list does not refresh
          on its own.
        </p>
        <form
          role="search"
          aria-label="Filter audit events"
          className={styles.filters}
          onSubmit={(event) => event.preventDefault()}
        >
          <Field label="Action">
            <Input
              {...actionField.inputProps}
              list={listId}
              maxLength={80}
              placeholder="For example skill.published"
            />
          </Field>
          <datalist id={listId}>
            {suggestions.map((action) => (
              <option key={action} value={action} />
            ))}
          </datalist>
          <Field label="Actor id">
            <Input {...actorField.inputProps} maxLength={120} placeholder="user_alex_admin" />
          </Field>
          <Field label="Outcome">
            <Select
              value={values.aout}
              onChange={(event) =>
                update({ aout: event.target.value as (typeof OUTCOME_FILTERS)[number] })
              }
            >
              {OUTCOME_FILTERS.map((value) => (
                <option key={value} value={value}>
                  {OUTCOME_LABELS[value]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Case">
            <CaseFilterSelect
              value={values.acase ?? ''}
              emptyLabel="Any case"
              showTitle={false}
              onChange={(value) => update({ acase: value || null })}
            />
          </Field>
          <Field label="From (UTC date)">
            <Input type="date" {...fromField.inputProps} />
          </Field>
          <Field label="To (UTC date)">
            <Input type="date" {...toField.inputProps} />
          </Field>
          <div className={styles.filterActions}>
            <Button variant="ghost" disabledFocusable={active === 0} onClick={clear}>
              Clear filters
            </Button>
          </div>
        </form>
        {boundary.isPending ? (
          <LoadingSkeleton variant="list" count={4} label="Loading audit events" />
        ) : boundary.isError ? (
          <QueryErrorState
            error={boundary.error}
            subject="The audit log"
            onRetry={() => void pages.refetch()}
            retrying={pages.isFetching}
          />
        ) : (
          <>
            {pages.isError ? (
              <QueryErrorState
                error={pages.error}
                subject={
                  pages.isFetchNextPageError ? 'More audit events' : 'The latest audit events'
                }
                compact
                onRetry={() => retryPages(pages)}
                retrying={pages.isFetching}
              />
            ) : null}
            <p className={styles.status} role="status" aria-live="polite">
              {events.length === 0
                ? 'No audit events to show.'
                : `Showing ${events.length} ${events.length === 1 ? 'event' : 'events'}${
                    typeof total === 'number' ? ` of ${total}` : ''
                  }${hasNextPage ? '; more load as you scroll' : ''}${
                    active > 0 ? `, ${active} ${active === 1 ? 'filter' : 'filters'} on` : ''
                  }.`}
            </p>
            {events.length === 0 ? (
              <EmptyState
                headingLevel={3}
                icon={active > 0 ? <HistoryIcon /> : <ShieldCheckIcon />}
                title={active > 0 ? 'No audit events match these filters' : 'No audit events yet'}
                description={
                  active > 0
                    ? 'Loosen or clear the filters to see more of the log.'
                    : 'Events appear here as people and the system act: ingesting, analysing, reviewing and changing settings.'
                }
                {...(active > 0
                  ? {
                      action: (
                        <Button variant="primary" onClick={clear}>
                          Clear filters
                        </Button>
                      ),
                    }
                  : {})}
              />
            ) : (
              <ul
                ref={containerRef}
                className={styles.list}
                aria-label={`Audit events, ${events.length} shown`}
                style={virtualized ? { position: 'relative', height: totalSize } : undefined}
              >
                {items.map((item) => {
                  const event = events[item.index];
                  if (!event) return null;
                  return (
                    <VirtualRow
                      key={item.key}
                      itemKey={item.key}
                      index={item.index}
                      count={events.length}
                      start={item.start}
                      virtualized={virtualized}
                      onMeasure={onMeasure}
                    >
                      <AuditRow event={event} />
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
                  {isFetchingNextPage ? 'Loading…' : 'Load more events'}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </Panel>
  );
}
