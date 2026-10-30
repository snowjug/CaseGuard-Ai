'use client';

import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import type { ReactNode } from 'react';
import { cg } from '../tokens/cg';

const useStyles = makeStyles({
  list: {
    display: 'grid',
    margin: 0,
    gap: `${cg.space[3]} ${cg.space[6]}`,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
  },
  cols1: { gridTemplateColumns: 'minmax(0, 1fr)' },
  cols2: {
    gridTemplateColumns: 'minmax(0, 1fr)',
    '@media (min-width: 640px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
  },
  cols3: {
    gridTemplateColumns: 'minmax(0, 1fr)',
    '@media (min-width: 640px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
    '@media (min-width: 1024px)': { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' },
  },
  item: { margin: 0, minWidth: 0 },
  inline: {
    display: 'grid',
    gridTemplateColumns: 'minmax(96px, 160px) minmax(0, 1fr)',
    columnGap: cg.space[3],
    alignItems: 'baseline',
  },
  term: {
    margin: 0,
    color: cg.textMuted,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
  },
  termInline: { fontSize: tokens.fontSizeBase300 },
  value: { margin: 0, color: cg.text, overflowWrap: 'anywhere' },
  mono: { fontFamily: cg.font.mono, fontSize: tokens.fontSizeBase200 },
  hint: { display: 'block', color: cg.textMuted, fontSize: tokens.fontSizeBase200 },
});

export interface KeyValueItem {
  /** Stable key; defaults to the label when it is a string. */
  id?: string;
  label: ReactNode;
  value: ReactNode;
  /** Secondary line under the value. */
  hint?: ReactNode;
  /** Render the value in a monospace face (ids, hashes). */
  mono?: boolean;
}

export interface KeyValueListProps {
  items: readonly KeyValueItem[];
  /** `stacked` puts the label above the value; `inline` puts them side by side. */
  layout?: 'stacked' | 'inline';
  /** Responsive column count for the stacked layout. */
  columns?: 1 | 2 | 3;
  className?: string;
  'aria-label'?: string;
}

/** Description list (`dl`) for metadata: labels are terms, values are definitions. */
export function KeyValueList({
  items,
  layout = 'stacked',
  columns = 2,
  className,
  'aria-label': ariaLabel,
}: KeyValueListProps) {
  const styles = useStyles();
  const columnClass =
    layout === 'inline'
      ? styles.cols1
      : columns === 1
        ? styles.cols1
        : columns === 2
          ? styles.cols2
          : styles.cols3;
  return (
    <dl aria-label={ariaLabel} className={mergeClasses(styles.list, columnClass, className)}>
      {items.map((item, index) => (
        <div
          key={item.id ?? (typeof item.label === 'string' ? item.label : index)}
          className={mergeClasses(styles.item, layout === 'inline' && styles.inline)}
        >
          <dt className={mergeClasses(styles.term, layout === 'inline' && styles.termInline)}>
            {item.label}
          </dt>
          <dd className={mergeClasses(styles.value, item.mono && styles.mono)}>
            {item.value}
            {item.hint ? <span className={styles.hint}>{item.hint}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}
