'use client';

import type { Evidence } from '@caseguard/schemas';
import { EVIDENCE_CATEGORY_LABELS } from '@caseguard/schemas';
import { Badge, CopyButton, UiLink, cg, formatDateTimeUtc, formatNumber } from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { CircleCheckIcon, CircleHelpIcon, CircleXIcon, InfoIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { evidenceLinkHref } from '../../lib/deep-links';
import { shortId } from '../../lib/format';
import { STRENGTH_LABELS } from '../reasoning/labels';
import { TruncatedText } from '../reasoning/TruncatedText';

const useStyles = makeStyles({
  item: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    minWidth: 0,
    paddingLeft: cg.space[3],
    borderLeft: `2px solid ${cg.borderSubtle}`,
    listStyle: 'none',
  },
  supports: { borderLeftColor: cg.tone.productive.solid },
  contradicts: { borderLeftColor: cg.tone.unsupported.solid },
  head: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  label: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
    overflowWrap: 'anywhere',
  },
  excerpt: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
    fontStyle: 'italic',
    overflowWrap: 'anywhere',
  },
  rationale: {
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    color: cg.textSecondary,
    overflowWrap: 'anywhere',
  },
  meta: {
    margin: 0,
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `0 ${cg.space[2]}`,
    fontSize: tokens.fontSizeBase200,
    color: cg.textMuted,
  },
  link: {
    color: cg.textLink,
    textDecorationLine: 'underline',
    textUnderlineOffset: '2px',
    minHeight: '24px',
    display: 'inline-flex',
    alignItems: 'center',
    '@media (pointer: coarse)': { minHeight: '44px' },
  },
});

export interface EvidenceBearing {
  polarity: 'supports' | 'contradicts' | 'neutral';
  /** Change in the hypothesis posterior caused by this evidence when it arrived, as a fraction (0.034 = 3.4 points). */
  effectOnConfidence?: number;
  rationale?: string;
}

const BEARING = {
  supports: { label: 'Supports', tone: 'productive', icon: CircleCheckIcon },
  contradicts: { label: 'Contradicts', tone: 'unsupported', icon: CircleXIcon },
  neutral: { label: 'Neutral', tone: 'neutral', icon: InfoIcon },
} as const;

export interface EvidenceLineProps {
  evidence: Evidence;
  caseId: string;
  /** How the evidence bears on one possible cause. */
  bearing: EvidenceBearing;
  /** Extra line under the quote. */
  note?: ReactNode;
}

/**
 * One piece of evidence for or against a possible cause, exactly as the case recorded it: label, whether it supports or
 * contradicts, how strong it is, the quoted text (plain text, shortened with an expand control), when it became known, how
 * far it moved the confidence, and a link to the event it came from. The shared evidence item of the reasoning pages still
 * uses the old badges, so this one is local to the possible-causes screen.
 */
export function EvidenceLine({ evidence, caseId, bearing, note }: EvidenceLineProps) {
  const styles = useStyles();
  const meta = BEARING[bearing.polarity];
  const Icon = meta.icon;
  const effect = bearing.effectOnConfidence;
  return (
    <li
      className={mergeClasses(
        styles.item,
        bearing.polarity === 'supports' && styles.supports,
        bearing.polarity === 'contradicts' && styles.contradicts,
      )}
    >
      <div className={styles.head}>
        <span className={styles.label}>{evidence.label}</span>
        <Badge tone={meta.tone} size="sm" icon={<Icon />}>
          {meta.label}
        </Badge>
        <Badge tone="neutral" size="sm" outlined>
          {STRENGTH_LABELS[evidence.strength]}
        </Badge>
        {evidence.kind === 'absence' ? (
          <Badge tone="missing" size="sm" outlined dashed icon={<CircleHelpIcon />}>
            Absence: not found
          </Badge>
        ) : null}
      </div>
      {evidence.excerpt ? (
        <p className={styles.excerpt}>
          <TruncatedText text={`“${evidence.excerpt}”`} />
        </p>
      ) : (
        <p className={styles.excerpt}>{evidence.summary}</p>
      )}
      {bearing.rationale ? <p className={styles.rationale}>{bearing.rationale}</p> : null}
      {note ? <p className={styles.rationale}>{note}</p> : null}
      <p className={styles.meta}>
        <span>{EVIDENCE_CATEGORY_LABELS[evidence.category]}</span>
        <span aria-hidden="true">·</span>
        <span>Known {formatDateTimeUtc(evidence.observedAt)}</span>
        {effect !== undefined ? (
          <>
            <span aria-hidden="true">·</span>
            <span>
              Moved confidence{' '}
              {formatNumber(effect * 100, { maximumFractionDigits: 1, signed: true })} points when
              it arrived (estimate)
            </span>
          </>
        ) : null}
        <span aria-hidden="true">·</span>
        <UiLink
          className={styles.link}
          href={evidenceLinkHref(caseId, { type: 'event', id: evidence.eventId })}
        >
          Source event {shortId(evidence.eventId, 12)}
        </UiLink>
        <CopyButton value={evidence.id} label={`Copy evidence id ${evidence.id}`} />
      </p>
    </li>
  );
}
