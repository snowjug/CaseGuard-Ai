'use client';

import type { CSSProperties, ReactNode } from 'react';
import { useInsightStyles } from './styles';

/**
 * Keeps the columns of a table readable. The shared table lays its columns out at equal widths and never wider than
 * its container, so on a phone a table of many columns becomes a few pixels per column with the text of one running
 * into the next. Inside this wrapper the table is never narrower than `columns` times a readable column, and one that
 * does not fit scrolls sideways in its own region instead.
 */
export function ReadableTable({ columns, children }: { columns: number; children: ReactNode }) {
  const styles = useInsightStyles();
  return (
    <div className={styles.readableTable} style={{ '--cg-columns': columns } as CSSProperties}>
      {children}
    </div>
  );
}
