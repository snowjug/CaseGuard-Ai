'use client';

import type { EvidenceLink } from '@caseguard/schemas';
import { Button, UiLink, borderColors, cg } from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import {
  ClockIcon,
  FileSearchIcon,
  FlaskConicalIcon,
  GitForkIcon,
  LightbulbIcon,
  ListChecksIcon,
  QuoteIcon,
  ZapIcon,
  type LucideIcon,
} from 'lucide-react';
import { useId, useState } from 'react';
import { evidenceLinkHref, evidenceLinkLabel } from '../../lib/deep-links';

const useStyles = makeStyles({
  list: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: cg.space[1],
    margin: 0,
    padding: 0,
    listStyleType: 'none',
  },
  item: { display: 'flex', minWidth: 0, maxWidth: '100%' },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: cg.space[1],
    minWidth: 0,
    maxWidth: '14rem',
    boxSizing: 'border-box',
    minHeight: '28px',
    paddingBlock: cg.space[1],
    paddingInline: cg.space[2],
    borderRadius: cg.radius.sm,
    border: `1px solid ${cg.glassBorder}`,
    backgroundColor: cg.surfaceRaised,
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    textDecorationLine: 'none',
    transitionProperty: 'color, border-color',
    transitionDuration: cg.motion.fast,
    transitionTimingFunction: cg.motion.easing,
    ':hover': {
      color: cg.text,
      ...borderColors(`color-mix(in srgb, ${cg.tone.brand.border} 55%, transparent)`),
    },
    ':focus-visible': { outline: `2px solid ${cg.focus}`, outlineOffset: '2px' },
    '@media (pointer: coarse)': { minHeight: '44px' },
  },
  icon: { display: 'inline-flex', flexShrink: 0, color: cg.tone.brand.fg },
  // A long label stays whole in the page (find-in-page and screen readers see it all) but shows one line, in full on hover.
  label: {
    minWidth: 0,
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 1,
    overflow: 'hidden',
    overflowWrap: 'anywhere',
  },
});

/** One small icon per kind of thing a link opens, so a row of chips can be read at a glance. */
const ICONS: Record<EvidenceLink['type'], LucideIcon> = {
  event: ClockIcon,
  action: ZapIcon,
  claim: QuoteIcon,
  evidence: FileSearchIcon,
  requirement: ListChecksIcon,
  hypothesis: LightbulbIcon,
  fork: GitForkIcon,
  scenario: FlaskConicalIcon,
};

/** Links shown before "Show more": a finding with many sources stays one tidy row or two. */
const VISIBLE = 3;

export interface EvidenceLinkListProps {
  caseId: string;
  links: readonly EvidenceLink[];
  /** Accessible name of the list, for example "Evidence for this penalty". */
  label: string;
  /** How many chips show before the rest fold behind "Show more" (default 3). */
  limit?: number;
}

/** The evidence a finding rests on, as links that open the page showing each item with it selected. */
export function EvidenceLinkList({ caseId, links, label, limit = VISIBLE }: EvidenceLinkListProps) {
  const styles = useStyles();
  const id = useId();
  const [all, setAll] = useState(false);
  if (links.length === 0) return null;
  const foldable = links.length > limit + 1;
  const shown = foldable && !all ? links.slice(0, limit) : links;
  return (
    <ul id={id} className={styles.list} aria-label={label}>
      {shown.map((link) => {
        const Icon = ICONS[link.type];
        const text = evidenceLinkLabel(link);
        return (
          <li key={`${link.type}:${link.id}`} className={styles.item}>
            <UiLink href={evidenceLinkHref(caseId, link)} className={styles.chip} title={text}>
              <span aria-hidden="true" className={styles.icon}>
                <Icon />
              </span>
              <span className={styles.label}>{text}</span>
            </UiLink>
          </li>
        );
      })}
      {foldable ? (
        <li className={styles.item}>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={all}
            aria-controls={id}
            onClick={() => setAll((value) => !value)}
          >
            {all ? 'Show fewer' : `Show ${links.length - limit} more`}
          </Button>
        </li>
      ) : null}
    </ul>
  );
}
