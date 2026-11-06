'use client';

import type { EvidenceLink } from '@caseguard/schemas';
import { cg } from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  FileTextIcon,
  FlaskConicalIcon,
  GitForkIcon,
  CircleHelpIcon,
  LightbulbIcon,
  MailIcon,
  PlayIcon,
  QuoteIcon,
  type LucideIcon,
} from 'lucide-react';
import { LINK_TYPE_WORDS, linkKey, uniqueLinks } from '../model/links';
import { linkLabel } from './provenance-view';
import { useEvidence } from './EvidenceProvider';

const ICONS: Record<EvidenceLink['type'], LucideIcon> = {
  event: MailIcon,
  claim: QuoteIcon,
  evidence: FileTextIcon,
  fork: GitForkIcon,
  action: PlayIcon,
  hypothesis: LightbulbIcon,
  requirement: CircleHelpIcon,
  scenario: FlaskConicalIcon,
};

const useStyles = makeStyles({
  list: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: cg.space[2],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  item: { display: 'flex', maxWidth: '100%', minWidth: 0 },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: cg.space[1],
    maxWidth: '100%',
    minWidth: 0,
    minHeight: '28px',
    paddingInline: cg.space[2],
    border: `1px solid ${cg.borderSubtle}`,
    borderRadius: cg.radius.pill,
    backgroundColor: cg.surface,
    color: cg.textSecondary,
    fontFamily: 'inherit',
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    cursor: 'pointer',
    transitionProperty: 'background-color, color',
    transitionDuration: cg.motion.fast,
    transitionTimingFunction: cg.motion.easing,
    ':hover': { backgroundColor: cg.surfaceRaised, color: cg.text },
    ':focus-visible': { outline: `2px solid ${cg.focus}`, outlineOffset: '2px' },
    '@media (max-width: 639px), (pointer: coarse)': {
      minHeight: '44px',
      paddingInline: cg.space[3],
    },
  },
  more: {
    border: '1px solid transparent',
    backgroundColor: 'transparent',
    color: cg.textLink,
  },
  icon: { flexShrink: 0 },
  label: {
    display: 'inline-block',
    maxWidth: '36ch',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});

export interface EvidenceChipsProps {
  /** The evidence behind the recommendation or decision point. */
  links: readonly EvidenceLink[];
  /** Names the group for assistive technology and for the drawer: the title of what the evidence supports. */
  subject: string;
  /** Titles resolved for links that arrived without a label (`useLinkTitles`). */
  titles?: ReadonlyMap<string, string>;
  /** How many chips to show before "and N more" (default 4). */
  max?: number;
}

/**
 * The evidence behind one recommendation or decision point as chips. Each chip is a real button that opens the evidence
 * drawer at that item, so from a recommendation to the verified source text is two interactions: this chip, then
 * reading what the drawer shows first. More than `max` links collapse into one "and N more" chip that opens the
 * drawer at the first hidden one.
 */
export function EvidenceChips({ links, subject, titles, max = 4 }: EvidenceChipsProps) {
  const styles = useStyles();
  const evidence = useEvidence();
  const all = uniqueLinks(links);
  if (all.length === 0) return null;
  const shown = all.slice(0, max);
  const hidden = all.slice(max);
  const firstHidden = hidden[0];
  const open = (focus: EvidenceLink): void => evidence.open({ links: all, focus, subject });
  return (
    <ul className={styles.list} aria-label={`Evidence for ${subject}`}>
      {shown.map((link) => {
        const Icon = ICONS[link.type];
        const label = linkLabel(link, titles);
        return (
          <li key={linkKey(link)} className={styles.item}>
            <button
              type="button"
              className={styles.chip}
              aria-haspopup="dialog"
              aria-label={`${LINK_TYPE_WORDS[link.type]}: ${label}`}
              title={`${LINK_TYPE_WORDS[link.type]}: ${label}`}
              onClick={() => open(link)}
            >
              <Icon aria-hidden="true" size={14} className={styles.icon} />
              <span className={styles.label}>{label}</span>
            </button>
          </li>
        );
      })}
      {firstHidden ? (
        <li className={styles.item}>
          <button
            type="button"
            className={mergeClasses(styles.chip, styles.more)}
            aria-haspopup="dialog"
            aria-label={`and ${hidden.length} more: show the other evidence for ${subject}`}
            onClick={() => open(firstHidden)}
          >
            and {hidden.length} more
          </button>
        </li>
      ) : null}
    </ul>
  );
}
