'use client';

import type { EvidenceLink } from '@caseguard/schemas';
import { cg } from '@caseguard/ui';
import { Button, makeStyles, tokens } from '@fluentui/react-components';
import {
  BeakerRegular,
  BranchForkRegular,
  DocumentBulletListRegular,
  LightbulbRegular,
  MailRegular,
  PlayRegular,
  QuestionCircleRegular,
  TextQuoteRegular,
  type FluentIcon,
} from '@fluentui/react-icons';
import { LINK_TYPE_WORDS, linkKey, uniqueLinks } from '../model/links';
import { linkLabel } from './provenance-view';
import { useEvidence } from './EvidenceProvider';

const ICONS: Record<EvidenceLink['type'], FluentIcon> = {
  event: MailRegular,
  claim: TextQuoteRegular,
  evidence: DocumentBulletListRegular,
  fork: BranchForkRegular,
  action: PlayRegular,
  hypothesis: LightbulbRegular,
  requirement: QuestionCircleRegular,
  scenario: BeakerRegular,
};

const useStyles = makeStyles({
  list: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: cg.space[1],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  chip: {
    maxWidth: '100%',
    minWidth: 0,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
  },
  label: {
    display: 'inline-block',
    maxWidth: '36ch',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    verticalAlign: 'bottom',
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
          <li key={linkKey(link)}>
            <Button
              size="small"
              shape="circular"
              appearance="outline"
              className={styles.chip}
              icon={<Icon />}
              aria-haspopup="dialog"
              aria-label={`${LINK_TYPE_WORDS[link.type]}: ${label}`}
              title={`${LINK_TYPE_WORDS[link.type]}: ${label}`}
              onClick={() => open(link)}
            >
              <span className={styles.label}>{label}</span>
            </Button>
          </li>
        );
      })}
      {firstHidden ? (
        <li>
          <Button
            size="small"
            shape="circular"
            appearance="subtle"
            className={styles.chip}
            aria-haspopup="dialog"
            aria-label={`Show ${hidden.length} more pieces of evidence for ${subject}`}
            onClick={() => open(firstHidden)}
          >
            and {hidden.length} more
          </Button>
        </li>
      ) : null}
    </ul>
  );
}
