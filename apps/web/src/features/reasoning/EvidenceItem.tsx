'use client';

import type { Evidence } from '@caseguard/schemas';
import { EVIDENCE_CATEGORY_LABELS } from '@caseguard/schemas';
import { Badge, CopyButton, UiLink, cg, formatDateTimeUtc, formatNumber } from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { CircleCheckIcon, CircleXIcon, InfoIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { evidenceLinkHref } from '../../lib/deep-links';
import { shortId } from '../../lib/format';
import { STRENGTH_LABELS } from './labels';
import { TruncatedText } from './TruncatedText';

const useStyles = makeStyles({
  item: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    padding: `${cg.space[3]} ${cg.space[3]}`,
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surfaceSunken,
    minWidth: 0,
    listStyle: 'none',
  },
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
  },
  rationale: {
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    color: cg.textSecondary,
    overflowWrap: 'anywhere',
  },
  mono: { fontFamily: cg.font.mono },
});

export interface EvidenceBearing {
  polarity: 'supports' | 'contradicts' | 'neutral';
  /** Change in the hypothesis posterior caused by this evidence when it arrived, as a fraction (0.034 = 3.4 points). */
  effectOnConfidence?: number;
  rationale?: string;
}

export interface EvidenceItemProps {
  evidence: Evidence;
  caseId: string;
  /** How the evidence bears on one hypothesis, when it is listed inside one. */
  bearing?: EvidenceBearing;
  /** Extra line under the quote (for example which hypotheses the evidence bears on). */
  note?: ReactNode;
}

const BEARING = {
  supports: { label: 'Supports', tone: 'productive', icon: CircleCheckIcon },
  contradicts: { label: 'Contradicts', tone: 'unsupported', icon: CircleXIcon },
  neutral: { label: 'Neutral', tone: 'neutral', icon: InfoIcon },
} as const;

/**
 * One piece of evidence, exactly as the case recorded it: label, how strong it is, the quoted text (always plain text,
 * shortened with an expand control), when it became known and a link to the event it came from.
 */
export function EvidenceItem({ evidence, caseId, bearing, note }: EvidenceItemProps) {
  const styles = useStyles();
  const meta = bearing ? BEARING[bearing.polarity] : null;
  const effect = bearing?.effectOnConfidence;
  return (
    <li className={styles.item}>
      <div className={styles.head}>
        <span className={styles.label}>{evidence.label}</span>
        {meta ? (
          <Badge tone={meta.tone} icon={<meta.icon />} size="sm">
            {meta.label}
          </Badge>
        ) : null}
        <Badge tone="neutral" icon={<InfoIcon />} size="sm" outlined>
          {STRENGTH_LABELS[evidence.strength]}
        </Badge>
        {evidence.kind === 'absence' ? (
          <Badge tone="missing" icon={<InfoIcon />} size="sm" outlined dashed>
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
      {bearing?.rationale ? <p className={styles.rationale}>{bearing.rationale}</p> : null}
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
