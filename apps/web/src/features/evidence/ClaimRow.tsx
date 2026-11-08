'use client';

import { PARTICIPANT_ROLE_LABELS, EVIDENCE_CATEGORY_LABELS, type Claim } from '@caseguard/schemas';
import {
  Badge,
  Button,
  ProvenanceBadge,
  StatusBadge,
  UiLink,
  cg,
  formatDateTimeUtc,
} from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { ChevronRightIcon, CircleDashedIcon } from 'lucide-react';
import { ExpandableText } from '../../components/case/ExpandableText';
import { REVIEW_STATE_LABELS } from '../../components/case/labels';
import { evidenceLinkHref } from '../../lib/deep-links';
import { clipText } from '../../lib/text';
import { EvidenceCategoryBadge } from './category-meta';
import { CLAIM_FLAG_LABELS, isCorrected } from './ledger-filters';

const useStyles = makeStyles({
  row: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    boxSizing: 'border-box',
    minWidth: 0,
    padding: `${cg.space[4]} ${cg.space[6]}`,
    transitionProperty: 'background-color',
    transitionDuration: cg.motion.fast,
    ':hover': { backgroundColor: `color-mix(in srgb, ${cg.text} 4%, transparent)` },
    '@media (max-width: 639px)': { padding: cg.space[4] },
  },
  selected: {
    boxShadow: `inset 3px 0 0 ${cg.tone.brand.solid}`,
    backgroundColor: cg.tone.brand.tint,
    ':hover': { backgroundColor: cg.tone.brand.tint },
  },
  top: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: `${cg.space[2]} ${cg.space[3]}`,
  },
  badges: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: cg.space[2],
    minWidth: 0,
  },
  note: { margin: 0, color: cg.textSecondary, fontSize: tokens.fontSizeBase200 },
  bottom: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: `${cg.space[1]} ${cg.space[3]}`,
  },
  source: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${cg.space[1]} ${cg.space[2]}`,
    margin: 0,
    minWidth: 0,
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase200,
  },
  time: { fontVariantNumeric: 'tabular-nums' },
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: '24px',
    color: cg.textLink,
    fontWeight: tokens.fontWeightSemibold,
    textDecorationLine: 'none',
    ':hover': { textDecorationLine: 'underline' },
    '@media (pointer: coarse)': { minHeight: '44px' },
  },
});

/** Where a claim stands with the reviewers: a quiet outline until someone has decided, then the decision in a status colour. */
export function ReviewStateBadge({ state }: { state: Claim['reviewState'] }) {
  const review = REVIEW_STATE_LABELS[state];
  if (state === 'pending') {
    return (
      <Badge tone="neutral" size="sm" outlined icon={<CircleDashedIcon />}>
        {review.label}
      </Badge>
    );
  }
  return <StatusBadge status={review.status} label={review.label} size="small" />;
}

export interface ClaimRowProps {
  caseId: string;
  claim: Claim;
  selected: boolean;
  asOf: string | null;
  onSelect: (claimId: string) => void;
}

/**
 * One claim of the list, kept to what answers "what is this based on?" at a glance: its category (and a quality flag, if
 * it has one), the claim, where it came from, and whether a reviewer has decided. Everything else is in the drawer.
 */
export function ClaimRow({ caseId, claim, selected, asOf, onSelect }: ClaimRowProps) {
  const styles = useStyles();
  const corrected = isCorrected(claim);
  const eventQuery = asOf ? `&asOf=${encodeURIComponent(asOf)}` : '';
  return (
    <article
      aria-label={`${EVIDENCE_CATEGORY_LABELS[claim.category]}: ${clipText(claim.text, 80)}`}
      aria-current={selected ? 'true' : undefined}
      className={mergeClasses(styles.row, selected && styles.selected)}
    >
      <div className={styles.top}>
        <div className={styles.badges}>
          <EvidenceCategoryBadge category={claim.category} />
          {claim.simulated ? <ProvenanceBadge kind="simulated" /> : null}
          {claim.flags.map((flag) => (
            <StatusBadge
              key={flag}
              status="unsupported"
              size="small"
              label={CLAIM_FLAG_LABELS[flag]}
            />
          ))}
        </div>
        {claim.reviewState !== 'pending' ? <ReviewStateBadge state={claim.reviewState} /> : null}
      </div>
      <ExpandableText text={claim.text} lines={3} label="claim text" />
      {corrected ? (
        <p className={styles.note}>
          Originally classified by the AI as {EVIDENCE_CATEGORY_LABELS[claim.aiCategory]}
        </p>
      ) : null}
      <div className={styles.bottom}>
        <p className={styles.source}>
          {claim.eventId ? (
            <UiLink
              href={`${evidenceLinkHref(caseId, { type: 'event', id: claim.eventId })}${eventQuery}`}
              className={styles.link}
            >
              Event {claim.eventId}
            </UiLink>
          ) : (
            <span>Not tied to one event</span>
          )}
          {claim.authorRole ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{PARTICIPANT_ROLE_LABELS[claim.authorRole]}</span>
            </>
          ) : null}
          <span aria-hidden="true">·</span>
          <time className={styles.time} dateTime={claim.timestamp}>
            {formatDateTimeUtc(claim.timestamp)}
          </time>
        </p>
        <Button
          size="sm"
          variant="ghost"
          icon={<ChevronRightIcon />}
          iconPosition="end"
          aria-haspopup="dialog"
          aria-label={`Details of this claim: ${clipText(claim.text, 60)}`}
          onClick={() => onSelect(claim.id)}
        >
          Details
        </Button>
      </div>
    </article>
  );
}
