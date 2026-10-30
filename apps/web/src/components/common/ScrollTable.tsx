'use client';

import { DataTable, ScrollRegion, type DataTableProps } from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';

const useStyles = makeStyles({
  // The labelled, focusable region is the single scroller; the table's own wrapper must not scroll as well.
  visible: { overflowX: 'visible' },
});

export interface ScrollTableProps<T> extends Omit<DataTableProps<T>, 'className'> {
  /** Accessible name of the scrollable region, for example "Dependencies, scrollable". */
  label: string;
  /** Narrowest width, in pixels, the table keeps before the region scrolls sideways (Fluent tables use a fixed layout). */
  minWidth?: number;
}

/**
 * A data table that stays readable on a phone: below `minWidth` the named, focusable region scrolls sideways instead
 * of squeezing every column, and the page itself never scrolls horizontally.
 */
export function ScrollTable<T>({ label, minWidth = 720, ...table }: ScrollTableProps<T>) {
  const styles = useStyles();
  return (
    <ScrollRegion label={label}>
      <div style={{ minWidth }}>
        <DataTable {...table} className={styles.visible} />
      </div>
    </ScrollRegion>
  );
}
