'use client';

import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { useMemo, useState, type ReactNode } from 'react';
import { useVisuallyHiddenClass } from '../a11y/VisuallyHidden';
import { cg } from '../tokens/cg';

export type SortDirection = 'ascending' | 'descending';
export interface SortState {
  columnId: string;
  direction: SortDirection;
}

export interface DataTableColumn<T> {
  /** Stable column id (used for sorting state). */
  id: string;
  /** Header content. */
  header: ReactNode;
  /** Renders the cell for a row. */
  cell: (row: T) => ReactNode;
  /** Value used for sorting; providing it makes the column sortable. `null` sorts last. */
  sortValue?: (row: T) => string | number | null | undefined;
  align?: 'start' | 'end' | 'center';
  /** CSS width of the column (for example `120px` or `20%`). */
  width?: string;
  /** Renders the first cell as a row header (`th scope="row"`) for screen readers. */
  rowHeader?: boolean;
}

export interface DataTableProps<T> {
  /** Accessible table name (rendered as the `caption`). */
  caption: string;
  /** Show the caption visually instead of hiding it. */
  captionVisible?: boolean;
  columns: readonly DataTableColumn<T>[];
  rows: readonly T[];
  getRowId: (row: T) => string;
  /** Controlled sort state. Omit for uncontrolled sorting (`defaultSort` sets the initial one). */
  sort?: SortState | null;
  defaultSort?: SortState | null;
  onSortChange?: (sort: SortState | null) => void;
  /** Highlights a row (for example the one open in a side panel). */
  selectedRowId?: string | null;
  /** Shown instead of the body when there are no rows. */
  empty?: ReactNode;
  dense?: boolean;
  className?: string;
}

const useStyles = makeStyles({
  wrap: { width: '100%', overflowX: 'auto' },
  table: { width: '100%', minWidth: 'max-content' },
  caption: {
    captionSide: 'top',
    textAlign: 'left',
    padding: `${cg.space[2]} 0`,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
  },
  headerCell: { color: cg.textSecondary, fontWeight: tokens.fontWeightSemibold },
  end: { justifyContent: 'flex-end', textAlign: 'right' },
  center: { justifyContent: 'center', textAlign: 'center' },
  cell: { color: cg.text, fontSize: tokens.fontSizeBase300 },
  selected: { backgroundColor: cg.tone.brand.tint },
  numeric: { fontVariantNumeric: 'tabular-nums' },
  empty: { padding: cg.space[6], textAlign: 'center', color: cg.textSecondary },
});

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function compareValues(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
): number {
  const aMissing = a === null || a === undefined;
  const bMissing = b === null || b === undefined;
  if (aMissing || bMissing) return aMissing === bMissing ? 0 : aMissing ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return collator.compare(String(a), String(b));
}

/** Sorts a copy of `rows` by `sort`; missing values always sort last, and the sort is stable. */
export function sortRows<T>(
  rows: readonly T[],
  columns: readonly DataTableColumn<T>[],
  sort: SortState | null,
): T[] {
  const column = sort ? columns.find((c) => c.id === sort.columnId) : undefined;
  const valueOf = column?.sortValue;
  if (!sort || !valueOf) return [...rows];
  const factor = sort.direction === 'ascending' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, value: valueOf(row) }))
    .sort((x, y) => {
      const xMissing = x.value === null || x.value === undefined;
      const yMissing = y.value === null || y.value === undefined;
      if (xMissing || yMissing)
        return xMissing === yMissing ? x.index - y.index : xMissing ? 1 : -1;
      return compareValues(x.value, y.value) * factor || x.index - y.index;
    })
    .map((entry) => entry.row);
}

/**
 * Accessible data table: native `table` semantics, a caption, `aria-sort` on sortable headers (activated by
 * keyboard through a real button) and a horizontally scrollable wrapper so wide tables never break the layout.
 */
export function DataTable<T>({
  caption,
  captionVisible = false,
  columns,
  rows,
  getRowId,
  sort: controlledSort,
  defaultSort = null,
  onSortChange,
  selectedRowId,
  empty,
  dense = false,
  className,
}: DataTableProps<T>) {
  const styles = useStyles();
  const hidden = useVisuallyHiddenClass();
  const [internalSort, setInternalSort] = useState<SortState | null>(defaultSort);
  const sort = controlledSort === undefined ? internalSort : controlledSort;

  const sortedRows = useMemo(() => sortRows(rows, columns, sort), [rows, columns, sort]);

  const toggleSort = (columnId: string): void => {
    let next: SortState | null;
    if (sort?.columnId !== columnId) next = { columnId, direction: 'ascending' };
    else if (sort.direction === 'ascending') next = { columnId, direction: 'descending' };
    else next = null;
    if (controlledSort === undefined) setInternalSort(next);
    onSortChange?.(next);
  };

  const alignClass = (align: DataTableColumn<T>['align']): string | undefined =>
    align === 'end' ? styles.end : align === 'center' ? styles.center : undefined;

  return (
    <div className={mergeClasses(styles.wrap, className)}>
      <Table size={dense ? 'extra-small' : 'medium'} className={styles.table} sortable>
        <caption className={captionVisible ? styles.caption : hidden}>{caption}</caption>
        <TableHeader>
          <TableRow>
            {columns.map((column) => {
              const sortable = column.sortValue !== undefined;
              const direction = sort?.columnId === column.id ? sort.direction : undefined;
              return (
                <TableHeaderCell
                  key={column.id}
                  className={mergeClasses(styles.headerCell, alignClass(column.align))}
                  style={column.width ? { width: column.width } : undefined}
                  sortable={sortable}
                  sortDirection={direction}
                  onClick={sortable ? () => toggleSort(column.id) : undefined}
                  scope="col"
                >
                  {column.header}
                </TableHeaderCell>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedRows.map((row) => {
            const id = getRowId(row);
            return (
              <TableRow
                key={id}
                className={id === selectedRowId ? styles.selected : undefined}
                aria-selected={id === selectedRowId ? true : undefined}
              >
                {columns.map((column) => (
                  <TableCell
                    key={column.id}
                    className={mergeClasses(styles.cell, alignClass(column.align))}
                    {...(column.rowHeader ? { role: 'rowheader' } : {})}
                  >
                    {column.cell(row)}
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {sortedRows.length === 0 && empty ? <div className={styles.empty}>{empty}</div> : null}
    </div>
  );
}
