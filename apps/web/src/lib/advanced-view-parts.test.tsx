import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../test/harness';
import { installMatchMedia } from '../../test/media';
import { ResponsiveTable, type ResponsiveColumn } from './advanced-view-parts';

interface Route {
  id: string;
  name: string;
  calls: number;
  note: string;
}

const ROWS: readonly Route[] = [
  { id: 'cases', name: 'Cases', calls: 12, note: 'Lists the cases' },
  { id: 'audit', name: 'Audit', calls: 3, note: 'Lists the audit events' },
];

const COLUMNS: readonly ResponsiveColumn<Route>[] = [
  {
    id: 'name',
    header: 'Route',
    rowHeader: true,
    cell: (row) => row.name,
    sortValue: (row) => row.name,
  },
  { id: 'calls', header: 'Calls', cell: (row) => row.calls, sortValue: (row) => row.calls },
  { id: 'note', header: 'Note', cell: (row) => row.note, card: 'hidden' },
  {
    id: 'open',
    header: 'Open',
    card: 'footer',
    cell: (row) => <button type="button">Open {row.name}</button>,
  },
];

const routes = (rows: readonly Route[] = ROWS) => (
  <ResponsiveTable
    caption="Routes"
    columns={COLUMNS}
    rows={rows}
    getRowId={(row) => row.id}
    defaultSort={{ columnId: 'name', direction: 'ascending' }}
    empty="No routes"
  />
);

describe('ResponsiveTable', () => {
  it('is a sorted table with the column headers on a screen', () => {
    installMatchMedia(() => false);
    renderApp(routes());
    const table = screen.getByRole('table', { name: 'Routes' });
    expect(within(table).getAllByRole('columnheader')).toHaveLength(4);
    const names = within(table)
      .getAllByRole('rowheader')
      .map((cell) => cell.textContent);
    expect(names).toEqual(['Audit', 'Cases']);
    expect(screen.queryByRole('list', { name: 'Routes' })).toBeNull();
  });

  it('turns every row into a card on a phone, from the same columns', () => {
    installMatchMedia((query) => query.includes('max-width: 639px'));
    renderApp(routes());
    expect(screen.queryByRole('table')).toBeNull();
    const cards = within(screen.getByRole('list', { name: 'Routes' })).getAllByRole('listitem');
    expect(cards).toHaveLength(2);
    // Sorted like the table, the first column as the heading and the other columns as labelled details.
    const first = within(cards[0] as HTMLElement);
    expect(first.getByText('Audit')).toBeInTheDocument();
    expect(first.getByText('Calls').tagName).toBe('DT');
    expect(first.getByText('3').tagName).toBe('DD');
    // A hidden column is left out, a footer column keeps its controls.
    expect(first.queryByText('Lists the audit events')).toBeNull();
    expect(first.getByRole('button', { name: 'Open Audit' })).toBeInTheDocument();
  });

  it('shows the empty message in both layouts', () => {
    installMatchMedia((query) => query.includes('max-width: 639px'));
    const phone = renderApp(routes([]));
    expect(screen.getByText('No routes')).toBeInTheDocument();
    phone.unmount();
    installMatchMedia(() => false);
    renderApp(routes([]));
    expect(screen.getByText('No routes')).toBeInTheDocument();
  });
});
