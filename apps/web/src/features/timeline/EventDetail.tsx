'use client';

import {
  EVENT_TYPE_LABELS,
  PARTICIPANT_ROLE_LABELS,
  type EventDetail as EventDetailData,
} from '@caseguard/schemas';
import {
  Button,
  CopyButton,
  EmptyState,
  KeyValueList,
  LoadingSkeleton,
  ProvenanceBadge,
  StatusBadge,
  UiLink,
  cg,
  formatDateTimeUtc,
  formatNumber,
  formatProbability,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { CalendarXIcon, HistoryIcon } from 'lucide-react';
import { AsOfLimited, asOfCall, asOfFresh, isRateLimited } from '../../components/case/as-of';
import { ExpandableText } from '../../components/case/ExpandableText';
import { EFFORT_LABELS, countOf } from '../../components/case/labels';
import { QueryErrorState } from '../../components/common/QueryErrorState';
import { useApiQuery } from '../../lib/api/hooks';
import { useAuth } from '../../lib/auth/context';
import { evidenceLinkHref } from '../../lib/deep-links';
import { EvidenceCategoryBadge } from '../evidence/category-meta';

const useStyles = makeStyles({
  section: { display: 'flex', flexDirection: 'column', gap: cg.space[2], minWidth: 0 },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.01em',
    overflowWrap: 'anywhere',
  },
  sub: { margin: 0, color: cg.textSecondary, fontSize: tokens.fontSizeBase300 },
  h4: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  item: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    minWidth: 0,
    paddingLeft: cg.space[3],
    borderLeft: `2px solid ${cg.borderSubtle}`,
  },
  badges: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
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
    '@media (pointer: coarse)': { minHeight: '44px' },
  },
  linkButton: {
    display: 'inline',
    padding: 0,
    border: 0,
    backgroundColor: 'transparent',
    color: cg.textLink,
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    textAlign: 'start',
    textDecorationLine: 'underline',
    ':focus-visible': { outline: `2px solid ${cg.focus}`, outlineOffset: '2px' },
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
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => onSelect(data.inResponseTo?.id ?? '')}
                >
                  {data.inResponseTo.title ?? EVENT_TYPE_LABELS[data.inResponseTo.type]} (
                  {formatDateTimeUtc(data.inResponseTo.timestamp)})
                </button>
              </li>
            ) : null}
            {data.responses.map((response) => (
              <li key={response.id} className={styles.note}>
                Answered by{' '}
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => onSelect(response.id)}
                >
                  {response.title ?? EVENT_TYPE_LABELS[response.type]} (
                  {formatDateTimeUtc(response.timestamp)})
                </button>
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
                  <EvidenceCategoryBadge category={claim.category} />
                  <span className={styles.note}>
                    Confidence {formatProbability(claim.confidence)} (estimate)
                  </span>
                </div>
                <ExpandableText text={claim.text} lines={3} label="claim" />
                <UiLink href={ledgerHref(claim.id)} className={styles.link}>
                  Open in Evidence
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
      <p className={styles.note}>
        {countOf(data.claims.length, 'claim')} and{' '}
        {countOf(data.evidence.length, 'evidence signal')} on this event.
      </p>
      <div className={styles.actions}>
        <Button
          variant="primary"
          icon={<HistoryIcon />}
          onClick={() => onKnownAsOf(event.timestamp)}
        >
          Show what was known here
        </Button>
      </div>
    </>
  );
}

/**
 * The selected event (`?sel=`) for the drawer: its full stored text, how it was received, the claims and evidence derived
 * from it with links into Evidence, and its place in the conversation. Read with the page's `asOf`, so an event after the
 * boundary is reported as withheld rather than shown.
 */
export function EventDetail({
  caseId,
  eventId,
  asOf,
  onClose,
  onSelect,
  onKnownAsOf,
}: EventDetailProps) {
  const auth = useAuth();
  const query = useApiQuery(
    'events.get',
    { params: { caseId, eventId }, query: asOf ? { asOf } : {}, ...asOfCall(asOf) },
    { enabled: auth.status === 'ready', ...asOfFresh(asOf) },
  );
  if (query.isPending) return <LoadingSkeleton variant="card" label="Loading the event" />;
  if (query.isError) {
    if (asOf !== null && isRateLimited(query.error)) {
      return (
        <AsOfLimited
          key={query.errorUpdatedAt}
          error={query.error}
          subject="this event"
          compact
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      );
    }
    if (query.error.isNotFound) {
      return (
        <EmptyState
          compact
          headingLevel={3}
          icon={<CalendarXIcon />}
          title="This event is not in the current view"
          description={
            asOf
              ? 'It may be after the selected moment, so it is withheld, or it no longer exists.'
              : 'It does not exist in this case.'
          }
          action={
            <Button variant="secondary" onClick={onClose}>
              Clear the selection
            </Button>
          }
        />
      );
    }
    return (
      <QueryErrorState
        compact
        error={query.error}
        subject="The event"
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  return (
    <Content
      data={query.data}
      caseId={caseId}
      asOf={asOf}
      onSelect={onSelect}
      onKnownAsOf={onKnownAsOf}
    />
  );
}
