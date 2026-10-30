'use client';

import {
  EVENT_TYPE_LABELS,
  PARTICIPANT_ROLE_LABELS,
  type EventDetail as EventDetailData,
} from '@caseguard/schemas';
import {
  EmptyState,
  KeyValueList,
  LoadingSkeleton,
  Panel,
  ProvenanceBadge,
  StatusBadge,
  UiLink,
  cg,
  CopyButton,
  formatDateTimeUtc,
  formatNumber,
  formatProbability,
} from '@caseguard/ui';
import { Button, Link, makeStyles, tokens } from '@fluentui/react-components';
import { DismissRegular, HistoryRegular } from '@fluentui/react-icons';
import { AsOfLimited, asOfCall, asOfFresh, isRateLimited } from '../../components/case/as-of';
import { CategoryBadge } from '../../components/case/CategoryBadge';
import { ExpandableText } from '../../components/case/ExpandableText';
import { EFFORT_LABELS, countOf } from '../../components/case/labels';
import { QueryErrorState } from '../../components/common/QueryErrorState';
import { useApiQuery } from '../../lib/api/hooks';
import { useAuth } from '../../lib/auth/context';
import { evidenceLinkHref } from '../../lib/deep-links';

const useStyles = makeStyles({
  head: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: cg.space[2],
  },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    overflowWrap: 'anywhere',
  },
  sub: { margin: 0, color: cg.textSecondary, fontSize: tokens.fontSizeBase300 },
  section: { display: 'flex', flexDirection: 'column', gap: cg.space[2], minWidth: 0 },
  h4: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  item: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    padding: cg.space[2],
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surfaceSunken,
    minWidth: 0,
  },
  badges: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[1] },
  note: {
    margin: 0,
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase200,
    overflowWrap: 'anywhere',
  },
  mono: { fontFamily: cg.font.mono, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere' },
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: '24px',
    color: cg.textLink,
    fontSize: tokens.fontSizeBase200,
    textDecorationLine: 'none',
    ':hover': { textDecorationLine: 'underline' },
  },
  actions: { display: 'flex', flexWrap: 'wrap', gap: cg.space[2] },
});

export interface EventDetailProps {
  caseId: string;
  eventId: string;
  asOf: string | null;
  onClose: () => void;
  onSelect: (eventId: string) => void;
  onKnownAsOf: (timestamp: string) => void;
  /** Heading level of the panel (2 beside the list, 2 inside a drawer too). */
  level?: 2 | 3;
}

function Content({
  data,
  caseId,
  asOf,
  onSelect,
  onKnownAsOf,
}: Pick<EventDetailProps, 'caseId' | 'asOf' | 'onSelect' | 'onKnownAsOf'> & {
  data: EventDetailData;
}) {
  const styles = useStyles();
  const { event } = data;
  const query = asOf ? `&asOf=${encodeURIComponent(asOf)}` : '';
  const ledgerHref = (claimId: string): string =>
    `${evidenceLinkHref(caseId, { type: 'claim', id: claimId })}${query}`;
  const ai = event.ai;
  return (
    <>
      <div className={styles.section}>
        <h3 className={styles.title}>{event.title ?? EVENT_TYPE_LABELS[event.type]}</h3>
        <p className={styles.sub}>
          {formatDateTimeUtc(event.timestamp, { seconds: true })} · {EVENT_TYPE_LABELS[event.type]}{' '}
          · {event.participantAlias} ({PARTICIPANT_ROLE_LABELS[event.participantRole]})
        </p>
      </div>
      <div className={styles.section}>
        <h4 className={styles.h4}>Text as stored (after redaction)</h4>
        <ExpandableText text={event.body} lines={10} label="full event text" />
      </div>
      <KeyValueList
        columns={1}
        layout="inline"
        aria-label="Event facts"
        items={[
          {
            id: 'id',
            label: 'Event ID',
            value: (
              <span>
                <span className={styles.mono}>{event.id}</span>{' '}
                <CopyButton value={event.id} label="Copy event ID" />
              </span>
            ),
          },
          { id: 'position', label: 'Position', value: `#${event.sequence + 1} in time order` },
          ...(event.channel ? [{ id: 'channel', label: 'Channel', value: event.channel }] : []),
          {
            id: 'pointer',
            label: 'Source location',
            value: <span className={styles.mono}>{event.sourcePointer}</span>,
          },
          ...(event.correlationIds.length > 0
            ? [{ id: 'corr', label: 'Correlation ids', value: event.correlationIds.join(', ') }]
            : []),
          {
            id: 'redaction',
            label: 'Redaction',
            value: event.redaction.redacted ? (
              <StatusBadge
                status="uncertain"
                size="small"
                label={`Redacted: ${event.redaction.categories.join(', ')}`}
              />
            ) : (
              'Nothing redacted'
            ),
          },
          ...(event.action
            ? [
                {
                  id: 'action',
                  label: 'Action',
                  value: event.action.label,
                  hint: `${EFFORT_LABELS[event.action.customerEffort]}${event.action.destructive ? ' · destructive' : ''}${
                    event.action.durationMinutes ? ` · ${event.action.durationMinutes} min` : ''
                  }`,
                },
              ]
            : []),
          ...(ai
            ? [
                {
                  id: 'ai',
                  label: 'AI assist in the original process',
                  value: (
                    <span>
                      {ai.model}: {formatNumber(ai.promptTokens)} prompt +{' '}
                      {formatNumber(ai.completionTokens)} completion tokens{' '}
                      <ProvenanceBadge kind="synthetic" />
                    </span>
                  ),
                },
              ]
            : []),
        ]}
      />
      {data.inResponseTo || data.responses.length > 0 ? (
        <div className={styles.section}>
          <h4 className={styles.h4}>Conversation</h4>
          <ul className={styles.list} aria-label="Related events">
            {data.inResponseTo ? (
              <li className={styles.note}>
                In response to{' '}
                <Link as="button" onClick={() => onSelect(data.inResponseTo?.id ?? '')}>
                  {data.inResponseTo.title ?? EVENT_TYPE_LABELS[data.inResponseTo.type]} (
                  {formatDateTimeUtc(data.inResponseTo.timestamp)})
                </Link>
              </li>
            ) : null}
            {data.responses.map((response) => (
              <li key={response.id} className={styles.note}>
                Answered by{' '}
                <Link as="button" onClick={() => onSelect(response.id)}>
                  {response.title ?? EVENT_TYPE_LABELS[response.type]} (
                  {formatDateTimeUtc(response.timestamp)})
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className={styles.section}>
        <h4 className={styles.h4}>Claims derived from this event</h4>
        {data.claims.length === 0 ? (
          <p className={styles.note}>No claims were derived from this event.</p>
        ) : (
          <ul className={styles.list} aria-label="Derived claims">
            {data.claims.map((claim) => (
              <li key={claim.id} className={styles.item}>
                <div className={styles.badges}>
                  <CategoryBadge category={claim.category} />
                  <span className={styles.note}>
                    Confidence {formatProbability(claim.confidence)} (estimate)
                  </span>
                </div>
                <ExpandableText text={claim.text} lines={3} label="claim" />
                <UiLink href={ledgerHref(claim.id)} className={styles.link}>
                  Open in the Evidence Ledger
                </UiLink>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className={styles.section}>
        <h4 className={styles.h4}>Evidence observed in this event</h4>
        {data.evidence.length === 0 ? (
          <p className={styles.note}>No evidence signals were observed in this event.</p>
        ) : (
          <ul className={styles.list} aria-label="Evidence">
            {data.evidence.map((item) => (
              <li key={item.id} className={styles.item}>
                <strong>{item.label}</strong>
                <p className={styles.note}>
                  {item.kind === 'presence' ? 'Present' : 'Absent'} · {item.strength} strength ·{' '}
                  confidence {formatProbability(item.confidence)} (estimate)
                </p>
                <ExpandableText text={item.excerpt} lines={2} label="evidence excerpt" />
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className={styles.actions}>
        <Button
          appearance="primary"
          icon={<HistoryRegular />}
          onClick={() => onKnownAsOf(event.timestamp)}
        >
          Show what was known as of this event
        </Button>
      </div>
      <p className={styles.note}>
        {countOf(data.claims.length, 'claim')} and{' '}
        {countOf(data.evidence.length, 'evidence signal')} on this event.
      </p>
    </>
  );
}

/**
 * The selected event (`?sel=`): its full stored text, how it was received, the claims and evidence derived from it with
 * links into the ledger, and its place in the conversation. Read with the page's `asOf`, so an event after the boundary
 * is reported as withheld rather than shown.
 */
export function EventDetail({
  caseId,
  eventId,
  asOf,
  onClose,
  onSelect,
  onKnownAsOf,
  level = 2,
}: EventDetailProps) {
  const auth = useAuth();
  const query = useApiQuery(
    'events.get',
    { params: { caseId, eventId }, query: asOf ? { asOf } : {}, ...asOfCall(asOf) },
    { enabled: auth.status === 'ready', ...asOfFresh(asOf) },
  );
  return (
    <Panel
      title="Event details"
      level={level}
      description="The source text and everything derived from it."
      actions={
        <Button
          appearance="subtle"
          size="small"
          icon={<DismissRegular />}
          aria-label="Close event details"
          onClick={onClose}
        />
      }
    >
      {query.isPending ? (
        <LoadingSkeleton variant="card" label="Loading the event" />
      ) : query.isError ? (
        asOf !== null && isRateLimited(query.error) ? (
          <AsOfLimited
            key={query.errorUpdatedAt}
            error={query.error}
            subject="this event"
            compact
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        ) : query.error.isNotFound ? (
          <EmptyState
            compact
            headingLevel={3}
            title="This event is not in the current view"
            description={
              asOf
                ? 'It may be after the selected moment, so it is withheld, or it no longer exists.'
                : 'It does not exist in this case.'
            }
            action={
              <Button appearance="outline" onClick={onClose}>
                Clear the selection
              </Button>
            }
          />
        ) : (
          <QueryErrorState
            compact
            error={query.error}
            subject="The event"
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        )
      ) : (
        <Content
          data={query.data}
          caseId={caseId}
          asOf={asOf}
          onSelect={onSelect}
          onKnownAsOf={onKnownAsOf}
        />
      )}
    </Panel>
  );
}
