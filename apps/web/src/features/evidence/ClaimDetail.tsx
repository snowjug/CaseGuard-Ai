'use client';

import {
  EVIDENCE_CATEGORIES,
  EVIDENCE_CATEGORY_LABELS,
  PARTICIPANT_ROLE_LABELS,
  type Claim,
  type EvidenceCategory,
  type Evidence,
  type MissingEvidence,
} from '@caseguard/schemas';
import {
  Accordion,
  AccordionItem,
  Badge,
  Button,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  Field,
  ProvenanceBadge,
  Select,
  StatusBadge,
  UiLink,
  cg,
  formatDateTimeUtc,
  formatProbability,
} from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { FileQuestionIcon } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ExpandableText } from '../../components/case/ExpandableText';
import { METHOD_LABELS, REVIEW_STATE_LABELS, countOf } from '../../components/case/labels';
import { ApiError, describeError } from '../../lib/api/errors';
import { useApiMutation } from '../../lib/api/hooks';
import { invalidateRoutes } from '../../lib/api/query-keys';
import { useAuth } from '../../lib/auth/context';
import { GatedAction, useSession } from '../../lib/auth/session';
import { evidenceLinkHref } from '../../lib/deep-links';
import { CRITICALITY_LABELS } from '../../lib/labels';
import { useToast } from '../../lib/toast';
import { EvidenceCategoryBadge } from './category-meta';
import { ReviewStateBadge } from './ClaimRow';
import { CLAIM_FLAG_LABELS, isCorrected } from './ledger-filters';
import { LaterDecisionsCaption } from './WhatWasKnownBar';

const useStyles = makeStyles({
  head: { display: 'flex', flexDirection: 'column', gap: cg.space[3], minWidth: 0 },
  badges: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  chips: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: cg.space[2],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[3], minWidth: 0 },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  step: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    minWidth: 0,
    paddingLeft: cg.space[3],
    borderLeft: `2px solid ${cg.borderSubtle}`,
  },
  support: { borderLeftColor: cg.tone.productive.solid },
  contradict: { borderLeftColor: cg.tone.unsupported.solid },
  label: {
    color: cg.textMuted,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
  },
  note: {
    margin: 0,
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase200,
    overflowWrap: 'anywhere',
  },
  text: {
    margin: 0,
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase300,
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
  recorded: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    padding: cg.space[3],
    borderRadius: cg.radius.md,
    backgroundColor: cg.tone.brand.tint,
  },
  strong: { margin: 0, fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold },
  review: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    paddingTop: cg.space[4],
    borderTop: `1px solid ${cg.borderSubtle}`,
  },
  h3: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
  },
  actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
});

interface ReviewControlsProps {
  caseId: string;
  claim: Claim;
  asOf: string | null;
  /** Called after a decision recorded while an earlier moment is shown: that view never shows it. */
  onRecordedInEarlierView?: (() => void) | undefined;
}

/**
 * The reviewer's decision on one claim: confirm the classification or correct it. The reason is required, the original
 * AI classification is never overwritten, the decision is audited and sent with the version the person saw, so a
 * concurrent change is reported as a conflict instead of being overwritten.
 *
 * Nothing in the cache is patched by hand afterwards: a decision applies to the whole record, so the ledger is reloaded
 * and each window answers for itself. An earlier window is never given the whole record's claim: it keeps the
 * classification it had at its moment and says the decision is not shown there.
 */
function ReviewControls({ caseId, claim, asOf, onRecordedInEarlierView }: ReviewControlsProps) {
  const styles = useStyles();
  const { can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { identityKey } = useAuth();
  const [category, setCategory] = useState<EvidenceCategory>(claim.category);
  const review = useApiMutation('claims.review', { invalidate: ['evidence.list', 'events.get'] });
  const changed = category !== claim.category;
  const trigger = (
    <Button variant="primary">
      {changed ? 'Correct classification' : 'Confirm classification'}
    </Button>
  );

  const decide = async (reason: string): Promise<void> => {
    try {
      await review.mutateAsync({
        params: { caseId, claimId: claim.id },
        body: { category, reason, expectedVersion: claim.version },
      });
      if (asOf) {
        setCategory(claim.category);
        onRecordedInEarlierView?.();
        toast.success('Decision recorded', {
          body: 'It is in the audit log and applies to the whole record. This earlier view does not show it.',
        });
      } else {
        toast.success(changed ? 'Classification corrected' : 'Classification confirmed', {
          body: 'The decision is recorded in the audit log. The original AI classification is kept.',
        });
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await invalidateRoutes(queryClient, identityKey, ['evidence.list']);
        throw new Error(
          'Someone else changed this claim while you were reviewing it. The ledger was reloaded with the latest version. Check it again, then repeat your decision if it still applies.',
          { cause: error },
        );
      }
      throw new Error(describeError(error), { cause: error });
    }
  };

  return (
    <section className={styles.review} aria-label="Reviewer decision">
      <h3 className={styles.h3}>Reviewer decision</h3>
      <p className={styles.text}>
        The AI proposed <strong>{EVIDENCE_CATEGORY_LABELS[claim.aiCategory]}</strong>. You can
        confirm the current classification or correct it. Your decision and reason are audited, and
        the original AI classification is always kept next to it.
      </p>
      <Field label="Classification">
        <Select
          value={category}
          onChange={(event) => setCategory(event.target.value as EvidenceCategory)}
        >
          {EVIDENCE_CATEGORIES.map((item) => (
            <option key={item} value={item}>
              {EVIDENCE_CATEGORY_LABELS[item]}
              {item === claim.aiCategory ? ' (AI proposal)' : ''}
            </option>
          ))}
        </Select>
      </Field>
      {asOf ? (
        <p className={styles.note}>
          A decision you record now applies to the whole record. Earlier views, like this one, never
          show a decision recorded after their moment.
        </p>
      ) : null}
      <div className={styles.actions}>
        {can('evidence:review') ? (
          <ConfirmDialog
            trigger={trigger}
            title={changed ? 'Correct this classification?' : 'Confirm this classification?'}
            confirmLabel={changed ? 'Record the correction' : 'Record the confirmation'}
            reason={{
              label: 'Reason for your decision',
              minLength: 5,
              maxLength: 1000,
              placeholder: 'Say what you checked, so the next reviewer can follow it.',
            }}
            onConfirm={decide}
          >
            <p>
              {changed ? (
                <>
                  Change the classification from{' '}
                  <strong>{EVIDENCE_CATEGORY_LABELS[claim.category]}</strong> to{' '}
                  <strong>{EVIDENCE_CATEGORY_LABELS[category]}</strong>.
                </>
              ) : (
                <>
                  Confirm the classification as{' '}
                  <strong>{EVIDENCE_CATEGORY_LABELS[claim.category]}</strong>.
                </>
              )}{' '}
              The original AI classification ({EVIDENCE_CATEGORY_LABELS[claim.aiCategory]}) stays on
              record, and this decision is written to the audit log with your reason.
            </p>
          </ConfirmDialog>
        ) : (
          <GatedAction permission="evidence:review">{trigger}</GatedAction>
        )}
      </div>
    </section>
  );
}

function EvidenceList({
  caseId,
  items,
  asOf,
  empty,
  label,
  side,
}: {
  caseId: string;
  items: readonly Evidence[];
  asOf: string | null;
  empty: string;
  label: string;
  side: 'support' | 'contradict';
}) {
  const styles = useStyles();
  const query = asOf ? `&asOf=${encodeURIComponent(asOf)}` : '';
  if (items.length === 0) return <p className={styles.note}>{empty}</p>;
  return (
    <ul className={styles.list} aria-label={label}>
      {items.map((item) => (
        <li
          key={item.id}
          className={mergeClasses(
            styles.step,
            side === 'support' ? styles.support : styles.contradict,
          )}
        >
          <strong>{item.label}</strong>
          <p className={styles.note}>
            {item.kind === 'presence' ? 'Present' : 'Absent'} · {item.strength} strength ·
            confidence {formatProbability(item.confidence)} (estimate) · observed{' '}
            {formatDateTimeUtc(item.observedAt)}
          </p>
          <ExpandableText text={item.excerpt || item.summary} lines={2} label="evidence excerpt" />
          <UiLink
            href={`${evidenceLinkHref(caseId, { type: 'event', id: item.eventId })}${query}`}
            className={styles.link}
          >
            Event {item.eventId}
          </UiLink>
        </li>
      ))}
    </ul>
  );
}

export interface ClaimDetailProps {
  caseId: string;
  claim: Claim;
  evidenceById: ReadonlyMap<string, Evidence>;
  missing: readonly MissingEvidence[];
  asOf: string | null;
  hypothesisName: (id: string) => string;
  /** Returns to the whole record, offered after a decision that the earlier view on screen cannot show. */
  onShowWholeRecord?: (() => void) | undefined;
}

/**
 * One claim in full, for the drawer: its text, the effective category beside the original AI classification (never
 * overwritten) with the reviewer's decision and reason, why it was classified that way, the evidence for and against it,
 * its source, and the reviewer controls. With a time cursor set, a decision made later is not shown.
 */
export function ClaimDetail({
  caseId,
  claim,
  evidenceById,
  missing,
  asOf,
  hypothesisName,
  onShowWholeRecord,
}: ClaimDetailProps) {
  const styles = useStyles();
  // The claim whose decision was made from an earlier view: that view keeps showing the classification it had.
  const [recordedFor, setRecordedFor] = useState<string | null>(null);
  const review = REVIEW_STATE_LABELS[claim.reviewState];
  const corrected = isCorrected(claim);
  const supporting = claim.supportingEvidenceIds.flatMap((id) => {
    const item = evidenceById.get(id);
    return item ? [item] : [];
  });
  const contradicting = claim.contradictingEvidenceIds.flatMap((id) => {
    const item = evidenceById.get(id);
    return item ? [item] : [];
  });
  const requirement = claim.missingEvidenceId
    ? missing.find((item) => item.id === claim.missingEvidenceId)
    : undefined;
  const eventQuery = asOf ? `&asOf=${encodeURIComponent(asOf)}` : '';
  return (
    <>
      <div className={styles.head}>
        <div className={styles.badges}>
          <EvidenceCategoryBadge category={claim.category} size="md" />
          {claim.simulated ? <ProvenanceBadge kind="simulated" /> : null}
          <ReviewStateBadge state={claim.reviewState} />
        </div>
        <ExpandableText text={claim.text} lines={8} label="claim text" />
        {claim.relatedHypothesisIds.length > 0 ? (
          <ul className={styles.chips} aria-label="Related causes">
            {claim.relatedHypothesisIds.map((id) => (
              <li key={id}>
                <Badge tone="hypothesis" size="sm" outlined>
                  {hypothesisName(id)}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <Accordion>
        <AccordionItem title="How it was classified" defaultOpen>
          <div className={styles.stack}>
            {asOf ? (
              recordedFor === claim.id ? (
                <div className={styles.recorded}>
                  <p className={styles.strong}>Your decision was recorded</p>
                  <p className={styles.note}>
                    It applies to the whole record and is in the audit log. This earlier view never
                    shows a decision recorded after its moment, so the claim still appears as it was
                    classified then.{' '}
                    {onShowWholeRecord ? (
                      <Button variant="ghost" size="sm" onClick={onShowWholeRecord}>
                        Show the whole record
                      </Button>
                    ) : null}
                  </p>
                </div>
              ) : (
                <LaterDecisionsCaption />
              )
            ) : null}
            <ul className={styles.list} aria-label="Classification history">
              <li className={styles.step}>
                <span className={styles.label}>Original AI classification (never overwritten)</span>
                <div className={styles.badges}>
                  <EvidenceCategoryBadge category={claim.aiCategory} />
                </div>
                <p className={styles.note}>
                  Proposed by: {METHOD_LABELS[claim.method].toLowerCase()} (rule{' '}
                  <span className={styles.mono}>{claim.ruleId}</span>). It is a proposal for review,
                  not a fact.
                </p>
              </li>
              {claim.reviewState !== 'pending' ? (
                <li className={styles.step}>
                  <span className={styles.label}>
                    {corrected ? 'Reviewer correction' : 'Reviewer decision'}
                  </span>
                  <div className={styles.badges}>
                    <EvidenceCategoryBadge category={claim.category} />
                    <StatusBadge status={review.status} label={review.label} size="small" />
                  </div>
                  {claim.reviewedAt ? (
                    <p className={styles.note}>
                      {claim.reviewedBy ? `By ${claim.reviewedBy} on ` : 'On '}
                      {formatDateTimeUtc(claim.reviewedAt)}
                    </p>
                  ) : null}
                  {claim.reviewReason ? (
                    <ExpandableText text={claim.reviewReason} lines={3} label="reviewer reason" />
                  ) : null}
                </li>
              ) : null}
            </ul>
          </div>
        </AccordionItem>

        <AccordionItem title="Why" defaultOpen>
          <div className={styles.stack}>
            <ExpandableText text={claim.explanation} lines={4} label="explanation" />
            <p className={styles.note}>
              Confidence {formatProbability(claim.confidence)} (a model estimate, not statistical
              truth) · {METHOD_LABELS[claim.method]} · version {claim.version}
            </p>
            {claim.flags.length > 0 ? (
              <div className={styles.badges} role="group" aria-label="Quality flags">
                {claim.flags.map((flag) => (
                  <StatusBadge
                    key={flag}
                    status="unsupported"
                    size="small"
                    label={CLAIM_FLAG_LABELS[flag]}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </AccordionItem>

        <AccordionItem title={`Supporting evidence (${supporting.length})`} defaultOpen>
          <EvidenceList
            caseId={caseId}
            items={supporting}
            asOf={asOf}
            label="Supporting evidence"
            empty="No evidence supports this claim."
            side="support"
          />
        </AccordionItem>

        <AccordionItem
          title={`Contradicting evidence (${contradicting.length})`}
          defaultOpen={contradicting.length > 0}
        >
          <EvidenceList
            caseId={caseId}
            items={contradicting}
            asOf={asOf}
            label="Contradicting evidence"
            empty="Nothing contradicts this claim."
            side="contradict"
          />
        </AccordionItem>

        {requirement ? (
          <AccordionItem title="Evidence that is missing" defaultOpen>
            <div className={styles.stack}>
              <div className={styles.badges}>
                <StatusBadge
                  status={requirement.criticality === 'critical' ? 'unsupported' : 'uncertain'}
                  size="small"
                  label={CRITICALITY_LABELS[requirement.criticality]}
                />
                <strong>{requirement.label}</strong>
              </div>
              <p className={styles.text}>{requirement.description}</p>
              <p className={styles.note}>Suggested ask: {requirement.askText}</p>
            </div>
          </AccordionItem>
        ) : null}

        <AccordionItem title="Source">
          <div className={styles.stack}>
            <p className={styles.note}>
              {formatDateTimeUtc(claim.timestamp, { seconds: true })}
              {claim.authorRole ? ` · ${PARTICIPANT_ROLE_LABELS[claim.authorRole]}` : ''}
              {claim.subject ? ` · about ${claim.subject}` : ''}
            </p>
            {claim.sourceRef?.excerpt ? (
              <ExpandableText text={claim.sourceRef.excerpt} lines={3} label="source excerpt" />
            ) : null}
            {claim.eventId ? (
              <UiLink
                href={`${evidenceLinkHref(caseId, { type: 'event', id: claim.eventId })}${eventQuery}`}
                className={styles.link}
              >
                Open event {claim.eventId} in the timeline
              </UiLink>
            ) : (
              <p className={styles.note}>This claim is not tied to one event.</p>
            )}
            <p className={styles.note}>
              Claim ID <span className={styles.mono}>{claim.id}</span>{' '}
              <CopyButton value={claim.id} label="Copy claim ID" />
            </p>
          </div>
        </AccordionItem>
      </Accordion>

      <ReviewControls
        key={`${claim.id}:${claim.version}`}
        caseId={caseId}
        claim={claim}
        asOf={asOf}
        onRecordedInEarlierView={() => setRecordedFor(claim.id)}
      />
      <p className={styles.note}>
        {countOf(supporting.length + contradicting.length, 'evidence item')} linked to this claim.
      </p>
    </>
  );
}

/** Shown in place of the detail when the selected claim is not in the loaded (or filtered, or boundary-limited) list. */
export function ClaimMissing({ onClose, searching }: { onClose: () => void; searching: boolean }) {
  return (
    <EmptyState
      compact
      headingLevel={3}
      icon={<FileQuestionIcon />}
      title={searching ? 'Looking for that claim…' : 'That claim is not in this view'}
      description={
        searching
          ? 'Loading more of the ledger to find it.'
          : 'It may be filtered out, recorded after the selected moment, or no longer exist.'
      }
      action={
        <Button variant="secondary" onClick={onClose}>
          Clear the selection
        </Button>
      }
    />
  );
}
