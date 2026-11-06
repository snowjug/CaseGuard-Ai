'use client';

import {
  Accordion,
  Badge,
  Card,
  DataTable,
  HelpButton,
  STATUS_META,
  Skeleton,
  VisuallyHidden,
  cg,
  sortRows,
  useMediaQuery,
  type BadgeStatus,
  type DataTableColumn,
  type DataTableProps,
  type KeyValueItem,
  type ToneName,
} from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { useId, type CSSProperties, type ReactNode } from 'react';

/**
 * The few parts the four Advanced views (Settings and audit, Usage and cost, System status, Guided demo) share: the
 * status summary card that opens each one, the card that holds their collapsed sections, a row of figures, and a table
 * that turns into a list of cards on a phone.
 */

const useStyles = makeStyles({
  summary: {
    gap: cg.space[4],
    '@media (max-width: 639px)': { padding: cg.space[4] },
  },
  top: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: cg.space[3] },
  tile: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: '40px',
    height: '40px',
    borderRadius: cg.radius.md,
    fontSize: tokens.fontSizeBase500,
  },
  titleLine: {
    display: 'flex',
    alignItems: 'center',
    gap: cg.space[1],
    flex: '1 1 160px',
    minWidth: 0,
  },
  eyebrow: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.textSecondary,
  },
  actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  body: { display: 'flex', flexDirection: 'column', gap: cg.space[2], minWidth: 0 },
  headline: {
    margin: 0,
    fontSize: tokens.fontSizeBase600,
    lineHeight: tokens.lineHeightBase600,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.02em',
    color: cg.text,
    overflowWrap: 'anywhere',
    '@media (max-width: 639px)': {
      fontSize: tokens.fontSizeBase500,
      lineHeight: tokens.lineHeightBase500,
    },
  },
  description: {
    margin: 0,
    maxWidth: '72ch',
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
  },
  badges: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  facts: {
    display: 'grid',
    margin: 0,
    paddingTop: cg.space[4],
    borderTop: `1px solid ${cg.borderSubtle}`,
    gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))',
    gap: `${cg.space[3]} ${cg.space[6]}`,
  },
  factsLarge: { gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))' },
  fact: { display: 'flex', flexDirection: 'column', gap: cg.space[1], minWidth: 0 },
  factLabel: {
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    fontWeight: tokens.fontWeightMedium,
    color: cg.textMuted,
  },
  factValue: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.text,
    overflowWrap: 'anywhere',
  },
  factValueLarge: {
    fontSize: tokens.fontSizeBase500,
    lineHeight: tokens.lineHeightBase500,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.015em',
    fontVariantNumeric: 'tabular-nums',
  },
  factMono: { fontFamily: cg.font.mono, fontSize: tokens.fontSizeBase200 },
  factHint: {
    display: 'block',
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    fontWeight: tokens.fontWeightRegular,
    color: cg.textMuted,
  },
  sections: { '@media (max-width: 639px)': { padding: cg.space[4] } },
  rows: { display: 'flex', flexDirection: 'column', margin: 0 },
  row: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    gap: cg.space[1],
    padding: `${cg.space[2]} 0`,
    borderTop: `1px solid ${cg.borderSubtle}`,
    ':first-child': { borderTop: 0, paddingTop: 0 },
    '@media (min-width: 640px)': {
      gridTemplateColumns: 'minmax(128px, 220px) minmax(0, 1fr)',
      columnGap: cg.space[6],
    },
  },
  term: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
  },
  definition: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.text,
    overflowWrap: 'anywhere',
    minWidth: 0,
  },
  tiles: {
    display: 'grid',
    margin: 0,
    gridTemplateColumns: 'repeat(auto-fill, minmax(136px, 1fr))',
    gap: cg.space[3],
  },
  stat: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    minWidth: 0,
    padding: `${cg.space[3]} ${cg.space[4]}`,
    borderRadius: cg.radius.md,
    backgroundColor: cg.surfaceSunken,
  },
  statValue: {
    margin: 0,
    fontSize: tokens.fontSizeBase500,
    lineHeight: tokens.lineHeightBase500,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.015em',
    fontVariantNumeric: 'tabular-nums',
    color: cg.text,
    overflowWrap: 'anywhere',
  },
  cards: { display: 'flex', flexDirection: 'column', margin: 0, padding: 0, listStyleType: 'none' },
  cardRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    padding: `${cg.space[3]} 0`,
    borderTop: `1px solid ${cg.borderSubtle}`,
    minWidth: 0,
    ':first-child': { borderTop: 0, paddingTop: 0 },
  },
  cardTitle: {
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
    overflowWrap: 'anywhere',
  },
  pairs: { display: 'flex', flexDirection: 'column', gap: cg.space[1], margin: 0 },
  pair: {
    display: 'grid',
    gridTemplateColumns: 'minmax(96px, 38%) minmax(0, 1fr)',
    gap: cg.space[3],
    alignItems: 'baseline',
  },
  pairLabel: {
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    color: cg.textMuted,
  },
  pairValue: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.text,
    overflowWrap: 'anywhere',
  },
  cardFooter: { display: 'flex', flexWrap: 'wrap', gap: cg.space[2], alignItems: 'center' },
  empty: {
    padding: cg.space[6],
    textAlign: 'center',
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase300,
  },
  skeleton: { display: 'flex', flexDirection: 'column', gap: cg.space[6] },
  autoColumns: {
    minWidth: 0,
    '& table': { tableLayout: 'auto', minWidth: 'var(--cg-table-min, 640px)' },
  },
  skeletonRow: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: cg.space[3] },
  skeletonFacts: {
    display: 'grid',
    gap: `${cg.space[3]} ${cg.space[6]}`,
    gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))',
    paddingTop: cg.space[4],
    borderTop: `1px solid ${cg.borderSubtle}`,
  },
  skeletonFact: { display: 'flex', flexDirection: 'column', gap: cg.space[2] },
  skeletonSection: { display: 'flex', alignItems: 'center', gap: cg.space[3], minHeight: '56px' },
});

export interface SummaryCardProps {
  /** The card's `h2`: what it is about, in two or three words ("Overall status"). */
  title: string;
  /** Explains the card in a popover. */
  help?: ReactNode;
  /** A lucide icon, shown in a tinted tile. */
  icon: ReactNode;
  /** Colour of the tile: green, amber or red say how things are; the accent and neutral are for no judgement. */
  tone?: ToneName;
  /** The state in one plain sentence. */
  headline: ReactNode;
  /** One supporting line under the headline. */
  description?: ReactNode;
  /** Status badges: `Badge`, `StatusBadge`, `ProvenanceBadge`. */
  badges?: ReactNode;
  /** A meter under the description (a progress bar). */
  meter?: ReactNode;
  /** Buttons at the end of the title row (secondary or ghost: the card is never the screen's primary button). */
  actions?: ReactNode;
  /** The key facts, under a hairline. */
  facts?: readonly KeyValueItem[];
  /** `large` sets the values as figures. */
  factsSize?: 'regular' | 'large';
  /** Accessible name of the facts list. */
  factsLabel?: string;
  /** Anything below the facts: a progress bar, the next step. */
  children?: ReactNode;
  busy?: boolean;
}

/**
 * The status summary every Advanced view opens with: what the state is at a glance (one sentence, a few badges, the key
 * figures), so nobody has to open a section to find out whether something needs attention.
 */
export function SummaryCard({
  title,
  help,
  icon,
  tone = 'brand',
  headline,
  description,
  badges,
  meter,
  actions,
  facts,
  factsSize = 'regular',
  factsLabel,
  children,
  busy,
}: SummaryCardProps) {
  const styles = useStyles();
  const headingId = useId();
  const colours = cg.tone[tone];
  return (
    <Card
      role="group"
      aria-labelledby={headingId}
      aria-busy={busy || undefined}
      hero
      glow
      padding="lg"
      className={styles.summary}
    >
      <div className={styles.top}>
        <span
          aria-hidden="true"
          className={styles.tile}
          style={{ backgroundColor: colours.tint, color: colours.fg }}
        >
          {icon}
        </span>
        <div className={styles.titleLine}>
          <h2 id={headingId} className={styles.eyebrow}>
            {title}
          </h2>
          {help ? (
            <HelpButton label={`About ${title}`} title={title}>
              {help}
            </HelpButton>
          ) : null}
        </div>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
      <div className={styles.body}>
        <p className={styles.headline}>{headline}</p>
        {description ? <p className={styles.description}>{description}</p> : null}
        {meter}
        {badges ? <div className={styles.badges}>{badges}</div> : null}
      </div>
      {facts && facts.length > 0 ? (
        <dl
          aria-label={factsLabel}
          className={mergeClasses(styles.facts, factsSize === 'large' && styles.factsLarge)}
        >
          {facts.map((fact, index) => (
            <div key={fact.id ?? index} className={styles.fact}>
              <dt className={styles.factLabel}>{fact.label}</dt>
              <dd
                className={mergeClasses(
                  styles.factValue,
                  factsSize === 'large' && styles.factValueLarge,
                  fact.mono && styles.factMono,
                )}
              >
                {fact.value}
                {fact.hint ? <span className={styles.factHint}>{fact.hint}</span> : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {children}
    </Card>
  );
}

/** The card that holds a view's collapsed sections: one glass surface, hairlines between the `AccordionItem`s. */
export function DetailSections({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return (
    <Card padding="md" className={styles.sections}>
      <Accordion>{children}</Accordion>
    </Card>
  );
}

/**
 * Facts as rows of a description list: the term on the left (above the value on a phone), the value on the right, a
 * quiet hint under it, hairlines between rows. For a handful of settings or details that are read, not compared.
 */
export function FactList({
  items,
  label,
}: {
  items: readonly KeyValueItem[];
  /** Names the list for assistive technology. */
  label: string;
}) {
  const styles = useStyles();
  return (
    <dl className={styles.rows} aria-label={label}>
      {items.map((item, index) => (
        <div key={item.id ?? index} className={styles.row}>
          <dt className={styles.term}>{item.label}</dt>
          <dd className={mergeClasses(styles.definition, item.mono && styles.factMono)}>
            {item.value}
            {item.hint ? <span className={styles.factHint}>{item.hint}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export interface StatItem {
  id: string;
  label: string;
  value: ReactNode;
  /** One quiet line under the value. */
  hint?: ReactNode;
}

/** A grid of figures (label, value, optional hint) as a description list, so each label is the term of its value. */
export function StatTiles({ items, label }: { items: readonly StatItem[]; label: string }) {
  const styles = useStyles();
  return (
    <dl className={styles.tiles} aria-label={label}>
      {items.map((item) => (
        <div key={item.id} className={styles.stat}>
          <dt className={styles.factLabel}>{item.label}</dt>
          <dd className={styles.statValue}>
            {item.value}
            {item.hint ? <span className={styles.factHint}>{item.hint}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export interface ResponsiveColumn<T> extends DataTableColumn<T> {
  /**
   * What the column becomes on a phone: the heading of each card (default: the first column), a row of controls under
   * the details (`footer`), or nothing (`hidden`).
   */
  card?: 'title' | 'footer' | 'hidden';
  /** The label shown on a phone card when `header` is not plain text. */
  label?: string;
}

export interface ResponsiveTableProps<T> extends Omit<DataTableProps<T>, 'columns'> {
  columns: readonly ResponsiveColumn<T>[];
  /** Under this width, in pixels, the rows become cards (default 640). */
  cardBelow?: number;
  /** The narrowest the table gets before it scrolls sideways, in pixels (default 640). */
  minWidth?: number;
}

function CardList<T>({
  caption,
  columns,
  rows,
  getRowId,
  sort,
  defaultSort,
  empty,
}: Omit<ResponsiveTableProps<T>, 'cardBelow'>) {
  const styles = useStyles();
  const visible = columns.filter((column) => column.card !== 'hidden');
  const title = visible.find((column) => column.card === 'title') ?? visible[0];
  const footer = visible.filter((column) => column.card === 'footer');
  const details = visible.filter((column) => column !== title && column.card !== 'footer');
  const ordered = sortRows(rows, columns, sort === undefined ? (defaultSort ?? null) : sort);
  if (ordered.length === 0) return empty ? <div className={styles.empty}>{empty}</div> : null;
  return (
    <ul aria-label={caption} className={styles.cards}>
      {ordered.map((row) => (
        <li key={getRowId(row)} className={styles.cardRow}>
          {title ? <div className={styles.cardTitle}>{title.cell(row)}</div> : null}
          <dl className={styles.pairs}>
            {details.map((column) => (
              <div key={column.id} className={styles.pair}>
                <dt className={styles.pairLabel}>
                  {column.label ?? (typeof column.header === 'string' ? column.header : column.id)}
                </dt>
                <dd className={styles.pairValue}>{column.cell(row)}</dd>
              </div>
            ))}
          </dl>
          {footer.length > 0 ? (
            <div className={styles.cardFooter}>
              {footer.map((column) => (
                <span key={column.id}>{column.cell(row)}</span>
              ))}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * The shared borderless `DataTable` (sticky header, row hover) on a screen, and a list of cards on a phone, where a
 * table of several columns cannot be read. The same columns drive both, so nothing is shown in one and missing from
 * the other.
 *
 * The table's columns are laid out automatically here: with its visually hidden caption, `DataTable`'s fixed layout
 * gives every column the same width in Chrome and ignores each column's `width`, so a long "Detail" column is squeezed
 * as narrow as a "Latency" one.
 */
export function ResponsiveTable<T>({
  cardBelow = 640,
  minWidth = 640,
  ...table
}: ResponsiveTableProps<T>) {
  const styles = useStyles();
  const phone = useMediaQuery(`(max-width: ${cardBelow - 1}px)`, false);
  if (phone) return <CardList {...table} />;
  return (
    <div
      className={styles.autoColumns}
      style={{ '--cg-table-min': `${minWidth}px` } as CSSProperties}
    >
      <DataTable {...table} />
    </div>
  );
}

export interface StateBadgeProps {
  status: BadgeStatus;
  label: string;
  /** What the state means, as a tooltip. Without it there is no tooltip: the shared `StatusBadge` always adds one. */
  title?: string;
  size?: 'sm' | 'md';
}

/**
 * A status pill (colour, icon and word) with a tooltip of the caller's own. The shared `StatusBadge` carries a fixed
 * sentence about investigation quality ("Advanced the investigation with supporting evidence"), which says nothing true
 * about a dependency, a budget or a demo step.
 */
export function StateBadge({ status, label, title, size = 'md' }: StateBadgeProps) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <Badge
      tone={meta.tone}
      icon={<Icon />}
      size={size}
      dashed={status === 'missing'}
      outlined={status === 'missing'}
      {...(title ? { title } : {})}
    >
      {label}
    </Badge>
  );
}

const SECTION_TITLE_WIDTHS = [28, 22, 18, 20, 24, 20, 22, 26] as const;

export interface ViewSkeletonProps {
  /** Announced to screen readers: "Loading system status". */
  label: string;
  /** How many figures the summary card shows (default 5). */
  facts?: number;
  /** How many collapsed sections follow the summary card (default 6). */
  sections?: number;
}

/**
 * The placeholder of an Advanced view while its data loads: the summary card (title, sentence, badges, figures), then the
 * card of collapsed sections, in the shape of the loaded page so nothing jumps. It is a polite `status` with `aria-busy`.
 */
export function ViewSkeleton({ label, facts = 5, sections = 6 }: ViewSkeletonProps) {
  const styles = useStyles();
  return (
    <div className={styles.skeleton} role="status" aria-busy="true" aria-live="polite">
      <VisuallyHidden>{label}…</VisuallyHidden>
      <Card hero padding="lg" className={styles.summary}>
        <div className={styles.skeletonRow}>
          <Skeleton width={40} height={40} radius="md" />
          <Skeleton width={128} height={16} />
        </div>
        <Skeleton width="48%" height={30} />
        <Skeleton width="64%" height={16} />
        <div className={styles.skeletonRow}>
          <Skeleton width={88} height={26} radius="pill" />
          <Skeleton width={144} height={26} radius="pill" />
        </div>
        <div className={styles.skeletonFacts}>
          {Array.from({ length: facts }, (_, index) => (
            <div key={index} className={styles.skeletonFact}>
              <Skeleton width="45%" height={12} />
              <Skeleton width="70%" height={18} />
            </div>
          ))}
        </div>
      </Card>
      <Card padding="md" className={styles.sections}>
        {Array.from({ length: sections }, (_, index) => (
          <div key={index} className={styles.skeletonSection}>
            <Skeleton width={20} height={20} radius="sm" />
            <Skeleton
              width={`${SECTION_TITLE_WIDTHS[index % SECTION_TITLE_WIDTHS.length]}%`}
              height={16}
            />
          </div>
        ))}
      </Card>
    </div>
  );
}
