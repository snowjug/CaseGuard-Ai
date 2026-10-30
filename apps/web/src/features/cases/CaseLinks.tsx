'use client';

import type { AnalysisRun } from '@caseguard/schemas';
import { Panel, UiLink, cg } from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { ChevronRightRegular } from '@fluentui/react-icons';
import { countOf } from '../../components/case/labels';
import { caseHref } from '../../lib/deep-links';
import { NAV_ITEMS } from '../../lib/nav';

const useStyles = makeStyles({
  grid: {
    display: 'grid',
    gap: cg.space[3],
    margin: 0,
    padding: 0,
    listStyle: 'none',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
  },
  card: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: cg.space[3],
    minHeight: '72px',
    padding: cg.space[3],
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surface,
    color: cg.text,
    textDecorationLine: 'none',
    ':hover': { backgroundColor: cg.surfaceSunken },
  },
  icon: { fontSize: '24px', color: cg.tone.brand.fg, display: 'inline-flex', flexShrink: 0 },
  body: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: 1 },
  title: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
    color: cg.textLink,
  },
  text: { fontSize: tokens.fontSizeBase200, color: cg.textSecondary },
  stat: { fontSize: tokens.fontSizeBase200, color: cg.text, fontVariantNumeric: 'tabular-nums' },
  chevron: { color: cg.textMuted, display: 'inline-flex', alignSelf: 'center' },
});

interface Destination {
  navId: string;
  section: string;
  stat: (counts: AnalysisRun['counts']) => string;
}

const DESTINATIONS: readonly Destination[] = [
  { navId: 'timeline', section: 'timeline', stat: (c) => countOf(c.events, 'event') },
  {
    navId: 'evidence',
    section: 'evidence',
    stat: (c) => `${countOf(c.claims, 'claim')} · ${countOf(c.evidence, 'evidence item')}`,
  },
  {
    navId: 'hypotheses',
    section: 'hypotheses',
    stat: (c) => countOf(c.hypotheses, 'hypothesis', 'hypotheses'),
  },
  {
    navId: 'counterfactual',
    section: 'counterfactual',
    stat: (c) => countOf(c.forks, 'decision fork'),
  },
  { navId: 'quality', section: 'quality', stat: (c) => countOf(c.warnings, 'live warning') },
];

export interface CaseLinksProps {
  caseId: string;
  asOf: string | null;
  /** Totals of the latest analysis; omitted while a time cursor is set (they describe the whole record). */
  counts: AnalysisRun['counts'] | null;
}

/** Entry points to every case page. With a time cursor set, the links carry it so each page opens at the same moment. */
export function CaseLinks({ caseId, asOf, counts }: CaseLinksProps) {
  const styles = useStyles();
  const query = asOf ? `?asOf=${encodeURIComponent(asOf)}` : '';
  return (
    <Panel
      title="Investigate this case"
      level={2}
      description={
        asOf
          ? 'Each page opens at the moment you have selected.'
          : 'Each page looks at the same case from a different angle.'
      }
    >
      <ul className={styles.grid} aria-label="Case pages">
        {DESTINATIONS.map((destination) => {
          const item = NAV_ITEMS.find((candidate) => candidate.id === destination.navId);
          if (!item) return null;
          const Icon = item.icon;
          return (
            <li key={destination.navId}>
              <UiLink
                href={`${caseHref(caseId, destination.section)}${query}`}
                className={styles.card}
              >
                <span aria-hidden="true" className={styles.icon}>
                  <Icon />
                </span>
                <span className={styles.body}>
                  <span className={styles.title}>{item.label}</span>
                  <span className={styles.text}>{item.description}</span>
                  {counts ? <span className={styles.stat}>{destination.stat(counts)}</span> : null}
                </span>
                <span aria-hidden="true" className={styles.chevron}>
                  <ChevronRightRegular />
                </span>
              </UiLink>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
