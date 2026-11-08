'use client';

import { makeStyles } from '@fluentui/react-components';
import type { CSSProperties, ReactNode } from 'react';

const useStyles = makeStyles({
  root: { minWidth: 0, '& table': { minWidth: 'calc(var(--cg-columns, 4) * 6.5rem)' } },
});

/**
 * Keeps the columns of a table readable. The shared table lays its columns out at equal widths and never wider than
 * its container, so on a phone a table of many columns becomes a few pixels per column with the text of one running
 * into the next. Inside this wrapper the table is never narrower than `columns` times a readable column, and one that
 * does not fit scrolls sideways in its own region instead.
 */
export function ReadableTable({ columns, children }: { columns: number; children: ReactNode }) {
  const styles = useStyles();
  return (
    <div className={styles.root} style={{ '--cg-columns': columns } as CSSProperties}>
      {children}
    </div>
  );
}
