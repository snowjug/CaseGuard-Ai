'use client';

import { PARTICIPANT_ROLE_LABELS, type Claim, EVIDENCE_CATEGORY_LABELS } from '@caseguard/schemas';
import {
  ProvenanceBadge,
  StatusBadge,
  UiLink,
  cg,
  formatDateTimeUtc,
  formatProbability,
} from '@caseguard/ui';
import { Button, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { SearchRegular } from '@fluentui/react-icons';
import { CategoryBadge } from '../../components/case/CategoryBadge';
import { ExpandableText } from '../../components/case/ExpandableText';
import { METHOD_LABELS, REVIEW_STATE_LABELS } from '../../components/case/labels';
import { evidenceLinkHref } from '../../lib/deep-links';
import { clipText } from '../../lib/text';
import { CLAIM_FLAG_LABELS, isCorrected } from './ledger-filters';

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    padding: cg.space[3],
    borderRadius: cg.radius.lg,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surface,
    minWidth: 0,
    marginBottom: cg.space[3],
  },
  selected: {
    boxShadow: `inset 4px 0 0 ${cg.tone.brand.solid}`,
    backgroundColor: cg.tone.brand.tint,
  },
  head: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${cg.space[1]} ${cg.space[3]}`,
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase200,
  },
  time: {
    color: cg.text,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: 'tabular-nums',
  },
  badges: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[1] },
  note: { margin: 0, color: cg.textSecondary, fontSize: tokens.fontSizeBase200 },
  chips: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: cg.space[1],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: '22px',
    padding: `0 ${cg.space[2]}`,
    borderRadius: cg.radius.pill,
    border: `1px solid ${cg.borderControl}`,
    backgroundColor: cg.surface,
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase200,
  },
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: '24px',
    color: cg.textLink,
    textDecorationLine: 'none',
    ':hover': { textDecorationLine: 'underline' },
  },
});

export interface ClaimRowProps {
  caseId: string;
  claim: Claim;
  selected: boolean;
  asOf: string | null;
  hypothesisName: (id: string) => string;
  onSelect: (claimId: string) => void;
}

/** One claim of the ledger: its category (and the original AI classification if a reviewer changed it), text and context. */
export function ClaimRow({
  caseId,
  claim,
  selected,
  asOf,
  hypothesisName,
  onSelect,
}: ClaimRowProps) {
  const styles = useStyles();
  const review = REVIEW_STATE_LABELS[claim.reviewState];
  const corrected = isCorrected(claim);
  const eventQuery = asOf ? `&asOf=${encodeURIComponent(asOf)}` : '';
  return (
    <article
      aria-label={`${EVIDENCE_CATEGORY_LABELS[claim.category]}: ${clipText(claim.text, 80)}`}
      aria-current={selected ? 'true' : undefined}
      className={mergeClasses(styles.card, selected && styles.selected)}
    >
      <div className={styles.head}>
        <CategoryBadge category={claim.category} />
        {claim.simulated ? <ProvenanceBadge kind="simulated" /> : null}
        <time className={styles.time} dateTime={claim.timestamp}>
          {formatDateTimeUtc(claim.timestamp)}
        </time>
        {claim.authorRole ? <span>{PARTICIPANT_ROLE_LABELS[claim.authorRole]}</span> : null}
        {claim.eventId ? (
          <UiLink
            href={`${evidenceLinkHref(caseId, { type: 'event', id: claim.eventId })}${eventQuery}`}
            className={styles.link}
          >
            Event {claim.eventId}
          </UiLink>
        ) : null}
      </div>
      <ExpandableText text={claim.text} lines={3} label="claim text" />
      <div className={styles.badges}>
        <span className={styles.note}>
          Confidence {formatProbability(claim.confidence)} (estimate)
        </span>
        <span className={styles.note}>{METHOD_LABELS[claim.method]}</span>
        {claim.reviewState !== 'pending' ? (
          <StatusBadge status={review.status} label={review.label} size="small" />
        ) : null}
        {corrected ? (
          <span className={styles.note}>
            Originally classified by the AI as {EVIDENCE_CATEGORY_LABELS[claim.aiCategory]}
          </span>
        ) : null}
        {claim.flags.map((flag) => (
          <StatusBadge
            key={flag}
            status="unsupported"
            size="small"
            label={CLAIM_FLAG_LABELS[flag]}
          />
        ))}
      </div>
      {claim.relatedHypothesisIds.length > 0 ? (
        <ul className={styles.chips} aria-label="Related hypotheses">
          {claim.relatedHypothesisIds.slice(0, 4).map((id) => (
            <li key={id} className={styles.chip}>
              {hypothesisName(id)}
            </li>
          ))}
          {claim.relatedHypothesisIds.length > 4 ? (
            <li className={styles.chip}>+{claim.relatedHypothesisIds.length - 4} more</li>
          ) : null}
        </ul>
      ) : null}
      <div>
        <Button
          size="small"
          appearance={selected ? 'primary' : 'outline'}
          icon={<SearchRegular />}
          aria-pressed={selected}
          aria-label={`Details of this claim: ${clipText(claim.text, 60)}`}
          onClick={() => onSelect(claim.id)}
        >
          Details
        </Button>
      </div>
    </article>
  );
}
