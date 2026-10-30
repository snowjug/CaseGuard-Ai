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
  ConfirmDialog,
  CopyButton,
  EmptyState,
  Notice,
  Panel,
  ProvenanceBadge,
  StatusBadge,
  UiLink,
  cg,
  formatDateTimeUtc,
  formatProbability,
} from '@caseguard/ui';
import { Button, Field, Select, makeStyles, tokens } from '@fluentui/react-components';
import { DismissRegular } from '@fluentui/react-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CategoryBadge } from '../../components/case/CategoryBadge';
import { LaterDecisionsNote } from '../../components/case/as-of';
import { ExpandableText } from '../../components/case/ExpandableText';
import { METHOD_LABELS, REVIEW_STATE_LABELS, countOf } from '../../components/case/labels';
import { ApiError, describeError } from '../../lib/api/errors';
import { useApiMutation } from '../../lib/api/hooks';
import { invalidateRoutes } from '../../lib/api/query-keys';
import { useAuth } from '../../lib/auth/context';
import { GatedAction, useSession } from '../../lib/auth/session';
import { CRITICALITY_LABELS } from '../../lib/labels';
import { evidenceLinkHref } from '../../lib/deep-links';
import { useToast } from '../../lib/toast';
import { CLAIM_FLAG_LABELS, isCorrected } from './ledger-filters';

const useStyles = makeStyles({
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
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    padding: cg.space[3],
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surface,
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
    <Button appearance="primary">
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
    <section className={styles.form} aria-label="Reviewer decision">
      <h3 className={styles.h4}>Reviewer decision</h3>
      <p className={styles.text}>
        The AI proposed <strong>{EVIDENCE_CATEGORY_LABELS[claim.aiCategory]}</strong>. You can
        confirm the current classification or correct it. Your decision and reason are audited, and
        the original AI classification is always kept next to it.
      </p>
      <Field label="Classification">
        <Select
          value={category}
          onChange={(_event, data) => setCategory(data.value as EvidenceCategory)}
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
        <Notice variant="info" compact title={null}>
          A decision you record now applies to the whole record. Earlier views, like this one, never
          show a decision recorded after their moment.
        </Notice>
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
}: {
  caseId: string;
  items: readonly Evidence[];
  asOf: string | null;
  empty: string;
  label: string;
}) {
  const styles = useStyles();
  const query = asOf ? `&asOf=${encodeURIComponent(asOf)}` : '';
  if (items.length === 0) return <p className={styles.note}>{empty}</p>;
  return (
    <ul className={styles.list} aria-label={label}>
      {items.map((item) => (
        <li key={item.id} className={styles.item}>
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
  onClose: () => void;
  /** Returns to the whole record, offered after a decision that the earlier view on screen cannot show. */
  onShowWholeRecord?: (() => void) | undefined;
}

/**
 * One claim in full: its text, the effective category beside the original AI classification (never overwritten) with
 * the reviewer's decision and reason, why it was classified that way, its source, the supporting and contradicting
 * evidence, and the reviewer controls. With a time cursor set, a decision made later is not shown.
 */
export function ClaimDetail({
  caseId,
  claim,
  evidenceById,
  missing,
  asOf,
  hypothesisName,
  onClose,
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
    <Panel
      title="Claim details"
      level={2}
      description="What was claimed, how it was classified and what supports it."
      actions={
        <Button
          appearance="subtle"
          size="small"
          icon={<DismissRegular />}
          aria-label="Close claim details"
          onClick={onClose}
        />
      }
    >
      <div className={styles.section}>
        <div className={styles.badges}>
          <CategoryBadge category={claim.category} size="medium" />
          {claim.simulated ? <ProvenanceBadge kind="simulated" /> : null}
          <StatusBadge status={review.status} label={review.label} size="small" />
        </div>
        <ExpandableText text={claim.text} lines={8} label="claim text" />
      </div>

      <div className={styles.section}>
        <h3 className={styles.h4}>Classification</h3>
        {asOf ? (
          recordedFor === claim.id ? (
            <Notice variant="info" compact title="Your decision was recorded">
              It applies to the whole record and is in the audit log. This earlier view never shows
              a decision recorded after its moment, so the claim still appears as it was classified
              then.{' '}
              {onShowWholeRecord ? (
                <Button appearance="transparent" size="small" onClick={onShowWholeRecord}>
                  Show the whole record
                </Button>
              ) : null}
            </Notice>
          ) : (
            <LaterDecisionsNote />
          )
        ) : null}
        <ul className={styles.list} aria-label="Classification history">
          <li className={styles.item}>
            <span className={styles.note}>Original AI classification (never overwritten)</span>
            <div className={styles.badges}>
              <CategoryBadge category={claim.aiCategory} />
            </div>
            <p className={styles.note}>
              Proposed by: {METHOD_LABELS[claim.method].toLowerCase()} (rule{' '}
              <span className={styles.mono}>{claim.ruleId}</span>). It is a proposal for review, not
              a fact.
            </p>
          </li>
          {claim.reviewState !== 'pending' ? (
            <li className={styles.item}>
              <span className={styles.note}>
                {corrected ? 'Reviewer correction' : 'Reviewer decision'}
              </span>
              <div className={styles.badges}>
                <CategoryBadge category={claim.category} />
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

      <div className={styles.section}>
        <h3 className={styles.h4}>Why</h3>
        <ExpandableText text={claim.explanation} lines={4} label="explanation" />
        <p className={styles.note}>
          Confidence {formatProbability(claim.confidence)} (a model estimate, not statistical truth)
          · {METHOD_LABELS[claim.method]} · version {claim.version}
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

      <div className={styles.section}>
        <h3 className={styles.h4}>Source</h3>
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

      {requirement ? (
        <div className={styles.section}>
          <h3 className={styles.h4}>Evidence that is missing</h3>
          <div className={styles.item}>
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
        </div>
      ) : null}

      {claim.relatedHypothesisIds.length > 0 ? (
        <div className={styles.section}>
          <h3 className={styles.h4}>Related hypotheses</h3>
          <ul className={styles.list} aria-label="Related hypotheses">
            {claim.relatedHypothesisIds.map((id) => (
              <li key={id} className={styles.text}>
                {hypothesisName(id)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className={styles.section}>
        <h3 className={styles.h4}>Supporting evidence ({supporting.length})</h3>
        <EvidenceList
          caseId={caseId}
          items={supporting}
          asOf={asOf}
          label="Supporting evidence"
          empty="No evidence supports this claim."
        />
      </div>
      <div className={styles.section}>
        <h3 className={styles.h4}>Contradicting evidence ({contradicting.length})</h3>
        <EvidenceList
          caseId={caseId}
          items={contradicting}
          asOf={asOf}
          label="Contradicting evidence"
          empty="Nothing contradicts this claim."
        />
      </div>

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
    </Panel>
  );
}

/** Shown in place of the detail when the selected claim is not in the loaded (or filtered, or boundary-limited) list. */
export function ClaimMissing({ onClose, searching }: { onClose: () => void; searching: boolean }) {
  return (
    <Panel title="Claim details" level={2}>
      <EmptyState
        compact
        headingLevel={3}
        title={searching ? 'Looking for that claim…' : 'That claim is not in this view'}
        description={
          searching
            ? 'Loading more of the ledger to find it.'
            : 'It may be filtered out, recorded after the selected moment, or no longer exist.'
        }
        action={
          <Button appearance="outline" onClick={onClose}>
            Clear the selection
          </Button>
        }
      />
    </Panel>
  );
}
