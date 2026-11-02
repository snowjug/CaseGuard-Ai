'use client';

import type { EvidenceLink } from '@caseguard/schemas';
import { CopyButton, LoadingSkeleton, Notice, StatusBadge, cg } from '@caseguard/ui';
import {
  Button,
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  OverlayDrawer,
  makeStyles,
  tokens,
  useId,
} from '@fluentui/react-components';
import { DismissRegular, HistoryRegular, OpenRegular } from '@fluentui/react-icons';
import { LinkButton } from '../../../components/common/LinkButton';
import { QueryErrorState } from '../../../components/common/QueryErrorState';
import { evidenceLinkHref } from '../../../lib/deep-links';
import { LINK_TYPE_WORDS, linkKey } from '../model/links';
import { plural } from '../model/words';
import {
  UNRESOLVED_WORDS,
  describeItem,
  linkLabel,
  orderItems,
  titlesByKey,
  type ItemView,
} from './provenance-view';
import { useProvenance } from './useProvenance';

const useStyles = makeStyles({
  surface: { maxWidth: '100vw' },
  subject: { margin: 0, color: cg.textSecondary, fontSize: tokens.fontSizeBase300 },
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
    gap: cg.space[2],
    minWidth: 0,
    padding: cg.space[3],
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surface,
  },
  head: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: cg.space[2] },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
    overflowWrap: 'anywhere',
  },
  type: { fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  byline: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textSecondary },
  figure: { margin: 0, display: 'flex', flexDirection: 'column', gap: cg.space[2] },
  quote: {
    margin: 0,
    padding: `${cg.space[2]} ${cg.space[3]}`,
    borderLeft: `4px solid ${cg.tone.evidence.solid}`,
    backgroundColor: cg.surfaceSunken,
    color: cg.text,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  mark: {
    padding: '0 2px',
    borderRadius: cg.radius.sm,
    backgroundColor: cg.tone.uncertain.tint,
    color: cg.text,
    fontWeight: tokens.fontWeightSemibold,
    textDecorationLine: 'underline',
    textDecorationStyle: 'solid',
    textUnderlineOffset: '3px',
  },
  caption: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: cg.space[2],
    fontSize: tokens.fontSizeBase200,
    color: cg.textSecondary,
  },
  actions: { display: 'flex', flexWrap: 'wrap', gap: cg.space[2] },
  details: { fontSize: tokens.fontSizeBase200, color: cg.textSecondary },
  summary: { cursor: 'pointer', color: cg.textLink, minHeight: '24px' },
  facts: {
    display: 'grid',
    gridTemplateColumns: 'max-content minmax(0, 1fr)',
    gap: `${cg.space[1]} ${cg.space[3]}`,
    margin: `${cg.space[2]} 0 0`,
  },
  term: { color: cg.textMuted },
  value: { margin: 0, overflowWrap: 'anywhere', fontFamily: cg.font.mono },
  recorded: { margin: `${cg.space[2]} 0 0`, overflowWrap: 'anywhere' },
  note: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textSecondary },
});

/** The page that owns each kind of link, by the name of its destination in the navigation. */
const PAGE_FOR_LINK: Record<EvidenceLink['type'], string> = {
  event: 'Case Timeline',
  action: 'Case Timeline',
  claim: 'Evidence Ledger',
  evidence: 'Evidence Ledger',
  requirement: 'Evidence Ledger',
  hypothesis: 'Hypothesis Arena',
  fork: 'Counterfactual Lab',
  scenario: 'Counterfactual Lab',
};

function Item({ caseId, view }: { caseId: string; view: ItemView }) {
  const styles = useStyles();
  const headingId = useId('evidence-item');
  const { body } = view;
  // An excerpt that could not be matched is never shown as a quotation: only here, labelled, for whoever investigates.
  const mismatchExcerpt = body.kind === 'mismatch' ? view.recordedExcerpt : null;
  return (
    <li className={styles.item}>
      <div className={styles.head}>
        <h3 id={headingId} className={styles.title}>
          {view.title}
        </h3>
        <span className={styles.type}>{view.typeWord}</span>
      </div>
      {view.byline ? <p className={styles.byline}>{view.byline}</p> : null}
      {body.kind === 'quote' ? (
        <figure className={styles.figure}>
          <blockquote className={styles.quote}>
            {body.beforeCut ? '… ' : null}
            {body.before}
            <mark className={styles.mark}>{body.match}</mark>
            {body.after}
            {body.afterCut ? ' …' : null}
          </blockquote>
          <figcaption className={styles.caption}>
            <StatusBadge
              status="productive"
              size="small"
              label="Checked against the stored message"
            />
            {view.fromTitle ? <span>From “{view.fromTitle}”</span> : null}
          </figcaption>
        </figure>
      ) : null}
      {body.kind === 'mismatch' ? (
        <Notice variant="warning" compact title="Could not be matched to the stored message">
          The analysis recorded an excerpt for this, but the stored message does not hold it where
          it was recorded, so it is not shown as a quotation. Read the message itself in the
          timeline.
        </Notice>
      ) : null}
      {body.kind === 'derived' ? (
        <Notice variant="info" compact title="Derived, no quotation">
          This comes from several messages or from structured details, so there is no single passage
          to quote.
        </Notice>
      ) : null}
      <div className={styles.actions}>
        {view.eventId ? (
          <LinkButton
            href={evidenceLinkHref(caseId, { type: 'event', id: view.eventId })}
            appearance="outline"
            size="small"
            icon={<HistoryRegular />}
          >
            Show in timeline
          </LinkButton>
        ) : (
          <LinkButton
            href={evidenceLinkHref(caseId, view.link)}
            appearance="outline"
            size="small"
            icon={<OpenRegular />}
          >
            Open in {PAGE_FOR_LINK[view.link.type]}
          </LinkButton>
        )}
      </div>
      {view.details.length > 0 || view.contentHash || mismatchExcerpt ? (
        <details className={styles.details}>
          <summary className={styles.summary}>Details</summary>
          {view.details.length > 0 ? (
            <dl className={styles.facts}>
              {view.details.map((fact) => (
                <div key={fact.label} style={{ display: 'contents' }}>
                  <dt className={styles.term}>{fact.label}</dt>
                  <dd className={styles.value}>{fact.value}</dd>
                </div>
              ))}
              {view.contentHash ? (
                <div style={{ display: 'contents' }}>
                  <dt className={styles.term}>Source hash</dt>
                  <dd className={styles.value}>
                    {view.contentHash.slice(0, 16)}…{' '}
                    <CopyButton value={view.contentHash} label="Copy the source hash" />
                  </dd>
                </div>
              ) : null}
            </dl>
          ) : null}
          {mismatchExcerpt ? (
            <p className={styles.recorded}>
              Recorded by the analysis, not matched to the stored message: {mismatchExcerpt}
            </p>
          ) : null}
        </details>
      ) : null}
    </li>
  );
}

function Content({
  caseId,
  links,
  focusKey,
}: {
  caseId: string;
  links: readonly EvidenceLink[];
  focusKey: string | null;
}) {
  const styles = useStyles();
  const { query, request } = useProvenance(caseId, links);
  if (request.links === null) {
    return <p className={styles.note}>There is nothing to look up for this item.</p>;
  }
  if (query.isPending) {
    return (
      <LoadingSkeleton
        variant="list"
        count={2}
        label="Checking the evidence against the stored messages"
      />
    );
  }
  if (query.isError) {
    return (
      <QueryErrorState
        compact
        subject="The evidence"
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  const titles = new Map([
    ...links.flatMap((link) =>
      link.label?.trim() ? [[linkKey(link), link.label.trim()] as const] : [],
    ),
    ...titlesByKey(query.data),
  ]);
  const items = orderItems(query.data.items, focusKey);
  return (
    <>
      {items.length > 0 ? (
        <ol className={styles.list} aria-label={`Evidence, ${plural(items.length, 'item')}`}>
          {items.map((item) => (
            <Item key={linkKey(item.link)} caseId={caseId} view={describeItem(item, titles)} />
          ))}
        </ol>
      ) : null}
      {query.data.unresolved.length > 0 ? (
        <Notice variant="warning" compact title="Not found">
          <ul>
            {query.data.unresolved.map((entry) => (
              <li key={linkKey(entry.link)}>
                {LINK_TYPE_WORDS[entry.link.type]} {linkLabel(entry.link, titles)}:{' '}
                {UNRESOLVED_WORDS[entry.reason]}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {request.left.length > 0 ? (
        <Notice variant="info" compact title="Not checked">
          {plural(request.left.length, 'more item')} could not be looked up here:{' '}
          {request.left.map((link) => linkLabel(link, titles)).join(', ')}.
        </Notice>
      ) : null}
    </>
  );
}

export interface EvidenceDrawerProps {
  caseId: string;
  open: boolean;
  links: readonly EvidenceLink[];
  focusKey: string | null;
  /** What the evidence supports, when the page opened the drawer from a recommendation or decision point. */
  subject: string | null;
  onClose: () => void;
}

/**
 * The evidence drawer: for each link of a recommendation or decision point, what it is, who wrote it and when, and for
 * text the verbatim passage with the matched part highlighted and a visible "checked against the stored message" badge.
 * Only a passage the server verified is shown as a quotation: one that could not be matched says so, and a derived item
 * shows its title with no quotation. Escape and the close button close it; focus is managed by Fluent's dialog and by the
 * provider, which returns it to the chip that opened the drawer.
 */
export function EvidenceDrawer({
  caseId,
  open,
  links,
  focusKey,
  subject,
  onClose,
}: EvidenceDrawerProps) {
  const styles = useStyles();
  return (
    <OverlayDrawer
      open={open}
      onOpenChange={(_event, data) => {
        if (!data.open) onClose();
      }}
      position="end"
      size="medium"
      className={styles.surface}
      aria-label="Evidence"
    >
      <DrawerHeader>
        <DrawerHeaderTitle
          action={
            <Button
              appearance="subtle"
              aria-label="Close the evidence"
              icon={<DismissRegular />}
              onClick={onClose}
            />
          }
        >
          Evidence
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        {open ? (
          <>
            {subject ? <p className={styles.subject}>For: {subject}</p> : null}
            <Content caseId={caseId} links={links} focusKey={focusKey} />
          </>
        ) : null}
      </DrawerBody>
    </OverlayDrawer>
  );
}
