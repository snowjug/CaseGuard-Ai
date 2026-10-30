'use client';

import {
  EVIDENCE_CATEGORIES,
  EVIDENCE_CATEGORY_LABELS,
  type EvidenceCategory,
} from '@caseguard/schemas';
import { Panel, cg, formatNumber } from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { CATEGORY_LOOKS } from '../../components/case/CategoryBadge';

const useStyles = makeStyles({
  grid: {
    display: 'grid',
    gap: cg.space[2],
    margin: 0,
    padding: 0,
    listStyle: 'none',
    gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
  },
  tile: {
    display: 'flex',
    alignItems: 'center',
    gap: cg.space[2],
    width: '100%',
    minHeight: '44px',
    padding: `${cg.space[2]} ${cg.space[3]}`,
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderControl}`,
    backgroundColor: cg.surface,
    color: cg.text,
    fontFamily: 'inherit',
    fontSize: tokens.fontSizeBase300,
    textAlign: 'left',
    cursor: 'pointer',
    ':hover': { backgroundColor: cg.surfaceSunken },
  },
  pressed: {
    border: `2px solid ${cg.tone.brand.solid}`,
    backgroundColor: cg.tone.brand.tint,
    fontWeight: tokens.fontWeightSemibold,
  },
  icon: { display: 'inline-flex', fontSize: '20px', flexShrink: 0 },
  label: { flex: 1, minWidth: 0, overflowWrap: 'anywhere' },
  count: { fontVariantNumeric: 'tabular-nums', fontWeight: tokens.fontWeightSemibold },
});

export interface CategoryTilesProps {
  counts: Readonly<Record<string, number>>;
  selected: 'all' | EvidenceCategory;
  onSelect: (category: 'all' | EvidenceCategory) => void;
}

/** The eight evidence categories as toggles with their counts (all claims known in the view, before other filters). */
export function CategoryTiles({ counts, selected, onSelect }: CategoryTilesProps) {
  const styles = useStyles();
  const total = EVIDENCE_CATEGORIES.reduce((sum, category) => sum + (counts[category] ?? 0), 0);
  return (
    <Panel
      title="Evidence categories"
      level={2}
      description="Every statement in the case is classified into one of eight categories. Choose one to filter the ledger."
      help="Confirmed facts are verified; customer-reported observations are what the customer said; engineer assumptions are statements without evidence; diagnostic evidence comes from logs and tool output; AI inferences are conclusions drawn from the rest; conflicting evidence contradicts another claim; missing evidence is what was needed and not collected; simulated outcomes come from counterfactual scenarios and never from the case itself."
    >
      <ul className={styles.grid} aria-label="Filter by evidence category">
        <li>
          <button
            type="button"
            className={mergeClasses(styles.tile, selected === 'all' && styles.pressed)}
            aria-pressed={selected === 'all'}
            onClick={() => onSelect('all')}
          >
            <span className={styles.label}>All categories</span>{' '}
            <span className={styles.count}>{formatNumber(total)}</span>
          </button>
        </li>
        {EVIDENCE_CATEGORIES.map((category) => {
          const look = CATEGORY_LOOKS[category];
          const Icon = look.icon;
          const pressed = selected === category;
          return (
            <li key={category}>
              <button
                type="button"
                className={mergeClasses(styles.tile, pressed && styles.pressed)}
                aria-pressed={pressed}
                onClick={() => onSelect(pressed ? 'all' : category)}
              >
                <span
                  aria-hidden="true"
                  className={styles.icon}
                  style={{ color: cg.tone[look.tone].fg }}
                >
                  <Icon />
                </span>
                <span className={styles.label}>{EVIDENCE_CATEGORY_LABELS[category]}</span>{' '}
                <span className={styles.count}>{formatNumber(counts[category] ?? 0)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
