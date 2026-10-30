import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '@fluentui/react-components';
import { describe, expect, it, vi } from 'vitest';
import type { MetricCard as MetricCardModel } from '@caseguard/schemas';
import { expectNoAxeViolations, renderWithTheme } from '../../test/axe';
import { ConfirmDialog } from './ConfirmDialog';
import { CopyButton } from './CopyButton';
import { DataTable, sortRows, type DataTableColumn } from './DataTable';
import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';
import { HelpButton } from './HelpButton';
import { KeyValueList } from './KeyValueList';
import { LoadingSkeleton } from './LoadingSkeleton';
import { MetricCard } from './MetricCard';
import { Notice } from './Notice';
import { PageHeader, SectionHeader } from './PageHeader';
import { ProvenanceBadge } from './ProvenanceBadge';
import { RangeBar } from './RangeBar';
import { StatusBadge } from './StatusBadge';
import { TimeCursor } from './TimeCursor';

const metric: MetricCardModel = {
  key: 'case_quality_index',
  label: 'Case Quality Index',
  value: 72,
  display: '72',
  unit: 'score',
  status: 'watch',
  trend: { direction: 'up', delta: 4.2, label: 'vs previous run' },
  definition: 'A weighted composite of six quality dimensions minus capped penalties.',
  formula: 'CQI = sum(weight x dimension) - penalties',
  range: { low: 64, high: 80 },
  estimated: true,
  synthetic: true,
  evidenceLink: { href: '/cases/case_1/quality', label: 'View score composition' },
  caseId: 'case_1',
};

describe('badges', () => {
  it('StatusBadge shows icon, text label and a pattern chip for each status', () => {
    const { container } = renderWithTheme(
      <>
        {(['productive', 'uncertain', 'unsupported', 'missing', 'neutral'] as const).map((s) => (
          <StatusBadge key={s} status={s} />
        ))}
      </>,
    );
    for (const label of ['Productive', 'Uncertain', 'Unsupported', 'Missing', 'Neutral']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(container.querySelectorAll('svg')).toHaveLength(5);
    // Uncertain uses a dotted chip, unsupported a cross-hatch, missing an outline: not colour alone.
    const chips = [...container.querySelectorAll('[aria-hidden="true"]')].map(
      (c) => (c as HTMLElement).style.backgroundImage,
    );
    expect(chips.some((b) => b.includes('radial-gradient'))).toBe(true);
    expect(chips.filter((b) => b.includes('repeating-linear-gradient')).length).toBeGreaterThan(0);
    expect(screen.getByText('Missing').parentElement?.getAttribute('style')).toContain('dashed');
  });

  it('StatusBadge can be icon-only and is then named for assistive technology', () => {
    renderWithTheme(<StatusBadge status="uncertain" iconOnly />);
    expect(screen.getByRole('img', { name: 'Uncertain' })).toBeInTheDocument();
  });

  it('ProvenanceBadge labels synthetic, estimated and simulated values', () => {
    renderWithTheme(
      <>
        <ProvenanceBadge kind="synthetic" />
        <ProvenanceBadge kind="estimated" />
        <ProvenanceBadge kind="simulated" />
      </>,
    );
    expect(screen.getByText('Synthetic')).toBeInTheDocument();
    expect(screen.getByText('Estimated')).toHaveStyle({ textDecoration: 'underline dotted' });
    expect(screen.getByText('Simulated').parentElement?.getAttribute('style')).toContain('dashed');
  });
});

describe('Notice, EmptyState, ErrorState, LoadingSkeleton', () => {
  it('Notice carries a text title and icon for every variant and is a note, not an alert', async () => {
    const { container } = renderWithTheme(
      <>
        <Notice variant="info">Everything is fine.</Notice>
        <Notice variant="warning">Be careful.</Notice>
        <Notice variant="synthetic">All data is synthetic.</Notice>
        <Notice variant="model-estimate">Confidence is a model estimate.</Notice>
      </>,
    );
    expect(screen.getAllByRole('note')).toHaveLength(4);
    for (const title of ['Information', 'Warning', 'Synthetic data', 'Model estimate']) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
    expect(screen.queryByRole('alert')).toBeNull();
    await expectNoAxeViolations(container);
  });

  it('EmptyState explains and offers the next action', async () => {
    const { container } = renderWithTheme(
      <EmptyState
        title="No cases yet"
        description="Load the synthetic sample from Cases."
        action={<Button appearance="primary">Open Cases</Button>}
      />,
    );
    expect(screen.getByRole('heading', { name: 'No cases yet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Cases' })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('ErrorState is an alert with a Retry that works and a copyable correlation id', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { container } = renderWithTheme(
      <ErrorState
        description="The API did not answer."
        error={{ status: 503, code: 'provider_unavailable', correlationId: 'cid-123' }}
        onRetry={onRetry}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('provider_unavailable')).toBeInTheDocument();
    expect(within(alert).getByText('cid-123')).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Copy correlation ID' })).toBeInTheDocument();
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    await expectNoAxeViolations(container);
  });

  it('ErrorState disables Retry while retrying', () => {
    renderWithTheme(<ErrorState onRetry={vi.fn()} retrying />);
    expect(screen.getByRole('button', { name: 'Retrying…' })).toBeDisabled();
  });

  it('LoadingSkeleton announces once and hides the shapes', async () => {
    const { container } = renderWithTheme(
      <LoadingSkeleton variant="metric" count={3} label="Loading metrics" />,
    );
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(within(status).getByText('Loading metrics…')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});

describe('headers, key-value list and help', () => {
  it('PageHeader renders one h1, a description, actions and a help popover', async () => {
    const user = userEvent.setup();
    const { container } = renderWithTheme(
      <PageHeader
        title="Command Center"
        description="Quality at a glance."
        actions={<Button>Refresh</Button>}
        help="Shows the active case."
        breadcrumbs={<nav aria-label="Breadcrumb">Home</nav>}
      />,
    );
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'About Command Center' }));
    expect(await screen.findByText('Shows the active case.')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('SectionHeader uses the requested heading level', () => {
    renderWithTheme(<SectionHeader title="Open warnings" level={3} />);
    expect(screen.getByRole('heading', { level: 3, name: 'Open warnings' })).toBeInTheDocument();
  });

  it('KeyValueList is a description list', async () => {
    const { container } = renderWithTheme(
      <KeyValueList
        items={[
          { label: 'Case', value: 'CASE-001', mono: true },
          { label: 'Opened', value: '14 Mar 2025, 09:42 UTC', hint: 'UTC' },
        ]}
      />,
    );
    expect(container.querySelectorAll('dt')).toHaveLength(2);
    expect(container.querySelectorAll('dd')).toHaveLength(2);
    await expectNoAxeViolations(container);
  });

  it('HelpButton opens a popover and Escape closes it, returning focus to the button', async () => {
    const user = userEvent.setup();
    renderWithTheme(
      <HelpButton label="About this page" title="Help">
        Explains the page.
      </HelpButton>,
    );
    const trigger = screen.getByRole('button', { name: 'About this page' });
    await user.click(trigger);
    expect(await screen.findByText('Explains the page.')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText('Explains the page.')).toBeNull());
    expect(trigger).toHaveFocus();
  });
});

describe('[FR-UX-07] MetricCard', () => {
  it('shows value, status in words, trend, estimated range, provenance badges and the evidence link', async () => {
    const { container } = renderWithTheme(<MetricCard metric={metric} />);
    const card = screen.getByRole('group', { name: 'Case Quality Index' });
    expect(within(card).getByText('72')).toBeInTheDocument();
    expect(within(card).getByText('Watch')).toBeInTheDocument();
    expect(within(card).getByText(/\+4\.2 vs previous run/)).toBeInTheDocument();
    expect(within(card).getByText(/\(improving\)/)).toBeInTheDocument();
    expect(within(card).getByText('Estimated range 64 to 80')).toBeInTheDocument();
    expect(within(card).getByText('Estimated')).toBeInTheDocument();
    expect(within(card).getByText('Synthetic')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'View score composition' })).toHaveAttribute(
      'href',
      '/cases/case_1/quality',
    );
    expect(
      within(card).getByRole('img', {
        name: /Case Quality Index estimated range: estimate 72, range 64 to 80, scale 0 to 100/,
      }),
    ).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('opens the definition popover with the formula and the model-estimate caveat', async () => {
    const user = userEvent.setup();
    renderWithTheme(<MetricCard metric={metric} />);
    await user.click(screen.getByRole('button', { name: 'What is Case Quality Index?' }));
    expect(await screen.findByText(metric.definition)).toBeInTheDocument();
    expect(screen.getByText(metric.formula as string)).toBeInTheDocument();
    expect(screen.getByText(/not a measured fact/)).toBeInTheDocument();
  });

  it('judges the trend direction by what is good for the metric (lower ASE is improving)', () => {
    renderWithTheme(
      <MetricCard
        metric={{
          ...metric,
          key: 'avoidable_support_effort',
          label: 'Avoidable Support Effort',
          display: '31%',
          unit: 'percent',
          value: 31,
          trend: { direction: 'down', delta: -6, label: 'vs previous run' },
          range: { low: 24, high: 40 },
        }}
      />,
    );
    expect(screen.getByText(/\(improving\)/)).toBeInTheDocument();
  });

  it('copes with an unknown value, no range, no trend and no evidence link', async () => {
    const { container } = renderWithTheme(
      <MetricCard
        metric={{
          ...metric,
          value: null,
          display: '—',
          status: 'unknown',
          trend: null,
          range: null,
          evidenceLink: null,
          estimated: false,
          synthetic: false,
        }}
      />,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('Not enough data')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText(/Estimated range/)).toBeNull();
    await expectNoAxeViolations(container);
  });
  it('shows a dash instead of a long placeholder when the value is unknown', () => {
    renderWithTheme(
      <MetricCard
        metric={{
          ...metric,
          value: null,
          display: 'Not enough data',
          status: 'unknown',
          trend: null,
          range: null,
        }}
      />,
    );
    const card = screen.getByRole('group', { name: 'Case Quality Index' });
    expect(within(card).getByText('—')).toBeInTheDocument();
    expect(within(card).getAllByText('Not enough data')).toHaveLength(1);
    expect(within(card).getByText('No value available')).toBeInTheDocument();
  });
});

describe('RangeBar', () => {
  it('states estimate, range and scale in its text alternative', () => {
    renderWithTheme(<RangeBar label="Confidence" value={62} low={48} high={74} />);
    expect(
      screen.getByRole('img', { name: 'Confidence: estimate 62, range 48 to 74, scale 0 to 100' }),
    ).toBeInTheDocument();
  });

  it('clamps out-of-range numbers and survives a missing range', () => {
    const { container } = renderWithTheme(
      <RangeBar label="X" value={500} low={null} high={null} />,
    );
    const marker = container.querySelector('span[style*="left"]') as HTMLElement;
    expect(marker.style.left).toBe('100%');
  });
});

interface Row {
  id: string;
  name: string;
  score: number | null;
}
const rows: Row[] = [
  { id: 'r1', name: 'Charlie', score: 30 },
  { id: 'r2', name: 'alpha', score: null },
  { id: 'r3', name: 'Bravo', score: 10 },
];
const columns: DataTableColumn<Row>[] = [
  { id: 'name', header: 'Name', cell: (r) => r.name, sortValue: (r) => r.name, rowHeader: true },
  {
    id: 'score',
    header: 'Score',
    cell: (r) => r.score ?? '—',
    sortValue: (r) => r.score,
    align: 'end',
  },
];

describe('DataTable', () => {
  it('sorts text case-insensitively, numbers numerically and keeps missing values last', () => {
    expect(
      sortRows(rows, columns, { columnId: 'name', direction: 'ascending' }).map((r) => r.id),
    ).toEqual(['r2', 'r3', 'r1']);
    expect(
      sortRows(rows, columns, { columnId: 'score', direction: 'ascending' }).map((r) => r.id),
    ).toEqual(['r3', 'r1', 'r2']);
    expect(
      sortRows(rows, columns, { columnId: 'score', direction: 'descending' }).map((r) => r.id),
    ).toEqual(['r1', 'r3', 'r2']);
    expect(sortRows(rows, columns, null).map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
  });

  it('exposes aria-sort, a caption, and cycles ascending, descending, none from the keyboard', async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    const { container } = renderWithTheme(
      <DataTable
        caption="Hypotheses"
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        onSortChange={onSortChange}
      />,
    );
    expect(screen.getByRole('table', { name: 'Hypotheses' })).toBeInTheDocument();
    const scoreHeader = screen.getByRole('columnheader', { name: /Score/ });
    expect(scoreHeader).toHaveAttribute('aria-sort', 'none');
    const button = within(scoreHeader).getByRole('button');
    button.focus();
    await user.keyboard('{Enter}');
    expect(scoreHeader).toHaveAttribute('aria-sort', 'ascending');
    expect(screen.getAllByRole('row')[1]).toHaveTextContent('Bravo');
    await user.keyboard('{Enter}');
    expect(scoreHeader).toHaveAttribute('aria-sort', 'descending');
    await user.keyboard('{Enter}');
    expect(scoreHeader).toHaveAttribute('aria-sort', 'none');
    expect(onSortChange).toHaveBeenCalledTimes(3);
    await expectNoAxeViolations(container);
  });

  it('shows the empty state when there are no rows', () => {
    renderWithTheme(
      <DataTable
        caption="Empty"
        columns={columns}
        rows={[]}
        getRowId={(r) => r.id}
        empty="No hypotheses yet"
      />,
    );
    expect(screen.getByText('No hypotheses yet')).toBeInTheDocument();
  });

  it('contains the visually hidden text of a wide table, so it cannot widen the page', () => {
    renderWithTheme(
      <DataTable caption="Contained" columns={columns} rows={rows} getRowId={(r) => r.id} />,
    );
    const wrapper = screen.getByRole('table', { name: 'Contained' }).parentElement;
    if (!wrapper) throw new Error('the table has a wrapper');
    const style = getComputedStyle(wrapper);
    expect(style.position).toBe('relative');
    expect(style.overflowX).toBe('auto');
  });

  it('is a named, keyboard-focusable scroll region only while the table is wider than its container', async () => {
    const scrollWidth = vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(900);
    const clientWidth = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(320);
    try {
      const { container, rerender } = renderWithTheme(
        <DataTable caption="Wide table" columns={columns} rows={rows} getRowId={(r) => r.id} />,
      );
      const region = await screen.findByRole('region', { name: 'Wide table, scrollable' });
      expect(region).toHaveAttribute('tabindex', '0');
      expect(within(region).getByRole('table', { name: 'Wide table' })).toBeInTheDocument();
      await expectNoAxeViolations(container);

      // Once it fits, nothing is added to the tab order.
      scrollWidth.mockReturnValue(300);
      rerender(
        <DataTable
          caption="Wide table"
          columns={columns}
          rows={rows.slice(0, 2)}
          getRowId={(r) => r.id}
        />,
      );
      await waitFor(() =>
        expect(screen.queryByRole('region', { name: 'Wide table, scrollable' })).toBeNull(),
      );
      expect(screen.getByRole('table', { name: 'Wide table' })).toBeInTheDocument();
    } finally {
      scrollWidth.mockRestore();
      clientWidth.mockRestore();
    }
  });
});

describe('TimeCursor', () => {
  const min = '2025-03-10T08:00:00Z';
  const max = '2025-03-12T08:00:00Z';

  it('announces "Known as of" for the boundary and reports changes from the slider', async () => {
    const onChange = vi.fn();
    const { container } = renderWithTheme(
      <TimeCursor
        min={min}
        max={max}
        value="2025-03-11T08:00:00Z"
        onChange={onChange}
        stepMinutes={60}
        commitDelayMs={0}
        withheldCount={4}
      />,
    );
    expect(screen.getAllByText('Known as of 11 Mar 2025, 08:00 UTC').length).toBeGreaterThan(0);
    expect(screen.getByText('4 later events are withheld from this view.')).toBeInTheDocument();
    const slider = screen.getByRole('slider', { name: 'Time cursor' });
    expect(slider).toHaveAttribute('aria-valuetext', 'Known as of 11 Mar 2025, 08:00 UTC');
    fireEvent.change(slider, { target: { value: '12' } });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('2025-03-10T20:00:00.000Z'));
    await expectNoAxeViolations(container);
  });

  it('reports null (no limit) at the end of the range and offers a Latest button', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithTheme(
      <TimeCursor
        min={min}
        max={max}
        value="2025-03-11T08:00:00Z"
        onChange={onChange}
        stepMinutes={60}
        commitDelayMs={0}
      />,
    );
    fireEvent.change(screen.getByRole('slider'), { target: { value: '48' } });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null));
    await user.click(screen.getByRole('button', { name: 'Latest' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('shows "Latest" with no boundary and steps between events with the buttons', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithTheme(
      <TimeCursor
        min={min}
        max={max}
        value="2025-03-11T08:00:00Z"
        onChange={onChange}
        markers={[{ at: '2025-03-10T12:00:00Z' }, { at: '2025-03-11T20:00:00Z' }]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Previous event' }));
    expect(onChange).toHaveBeenLastCalledWith('2025-03-10T12:00:00.000Z');
    await user.click(screen.getByRole('button', { name: 'Next event' }));
    expect(onChange).toHaveBeenLastCalledWith('2025-03-11T20:00:00.000Z');
  });

  it('says so when there is no time range to scrub', () => {
    renderWithTheme(<TimeCursor min={min} max={min} value={null} onChange={vi.fn()} />);
    expect(screen.getByText(/no time range to scrub/)).toBeInTheDocument();
  });

  it('shows the boundary exactly, even between slider steps, so it never displays a later instant', () => {
    renderWithTheme(
      <TimeCursor
        min={min}
        max={max}
        value="2025-03-11T07:59:59Z"
        onChange={vi.fn()}
        stepMinutes={5}
        withheldCount={2}
      />,
    );
    expect(screen.getAllByText('Known as of 11 Mar 2025, 07:59:59 UTC').length).toBeGreaterThan(0);
    expect(screen.queryByText('Known as of 11 Mar 2025, 08:00 UTC')).toBeNull();
  });
});

describe('ConfirmDialog', () => {
  it('is an alert dialog that restores focus to the opener on cancel', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    renderWithTheme(
      <ConfirmDialog
        trigger={<Button>Reset demo</Button>}
        title="Reset the demo data?"
        confirmLabel="Reset"
        tone="danger"
        onConfirm={onConfirm}
      >
        This removes all synthetic cases and restores the seed.
      </ConfirmDialog>,
    );
    const opener = screen.getByRole('button', { name: 'Reset demo' });
    await user.click(opener);
    const dialog = await screen.findByRole('alertdialog', { name: 'Reset the demo data?' });
    expect(within(dialog).getByText(/removes all synthetic cases/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(onConfirm).not.toHaveBeenCalled();
    // Fluent restores focus through Tabster's restorer, which needs real layout; jsdom cannot move focus, so the
    // unit test asserts the wiring and the Playwright pass on the design lab asserts the actual focus return.
    expect(opener).toHaveAttribute('data-tabster', expect.stringContaining('restorer'));
  });

  it('requires a reason of the minimum length before confirming and passes it on', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    renderWithTheme(
      <ConfirmDialog
        trigger={<Button>Reject path</Button>}
        title="Reject this counterfactual?"
        confirmLabel="Reject"
        reason={{ label: 'Reason for rejecting' }}
        onConfirm={onConfirm}
      >
        The rejection is audited.
      </ConfirmDialog>,
    );
    await user.click(screen.getByRole('button', { name: 'Reject path' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(within(dialog).getByText('Enter at least 5 characters.')).toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox'), '  Uses data from the future  ');
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('Uses data from the future'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('stays open and shows the error when the action fails', async () => {
    const user = userEvent.setup();
    renderWithTheme(
      <ConfirmDialog
        trigger={<Button>Delete</Button>}
        title="Delete case?"
        onConfirm={() => Promise.reject(new Error('Case is locked'))}
      >
        This cannot be undone.
      </ConfirmDialog>,
    );
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await within(dialog).findByText('Case is locked')).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  describe('while the action runs', () => {
    /** A promise settled by hand: an action that takes a while. */
    function deferred() {
      let resolve: () => void = () => undefined;
      let reject: (reason: unknown) => void = () => undefined;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    async function startAction(
      onConfirm: () => Promise<void>,
      onOpenChange: (open: boolean) => void = () => undefined,
    ) {
      const user = userEvent.setup();
      const view = renderWithTheme(
        <ConfirmDialog
          trigger={<Button>Delete</Button>}
          title="Delete case?"
          onOpenChange={onOpenChange}
          onConfirm={onConfirm}
        >
          This cannot be undone.
        </ConfirmDialog>,
      );
      await user.click(screen.getByRole('button', { name: 'Delete' }));
      const dialog = await screen.findByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
      await waitFor(() =>
        expect(within(dialog).getByRole('button', { name: 'Confirm' })).toBeDisabled(),
      );
      return { user, dialog, view };
    }

    it('ignores Escape, so the failure it ends with is shown in the dialog that is still open', async () => {
      const action = deferred();
      const onOpenChange = vi.fn();
      const focus = vi.spyOn(HTMLElement.prototype, 'focus');
      const { dialog } = await startAction(() => action.promise, onOpenChange);
      onOpenChange.mockClear();

      fireEvent.keyDown(dialog, { key: 'Escape' });
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
      expect(onOpenChange).not.toHaveBeenCalled();

      const focusedBefore = focus.mock.calls.length;
      await act(async () => {
        action.reject(new Error('Case is locked'));
        await action.promise.catch(() => undefined);
      });
      expect(await within(dialog).findByText('Case is locked')).toBeInTheDocument();
      const confirm = within(dialog).getByRole('button', { name: 'Confirm' });
      expect(confirm).toBeEnabled();
      // A browser takes the focus away from the button that was disabled, and a dialog whose focus is outside it does
      // not hear Escape: the focus is handed back to the button (jsdom keeps it, so what counts is the call).
      await waitFor(() => expect(focus.mock.contexts.slice(focusedBefore)).toContain(confirm));
      focus.mockRestore();

      // Once it has settled the dialog can be dismissed again.
      fireEvent.keyDown(dialog, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('cannot be cancelled or confirmed again, and closes by itself when the action succeeds', async () => {
      const action = deferred();
      const onConfirm = vi.fn(() => action.promise);
      const { dialog } = await startAction(onConfirm);
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
      fireEvent.keyDown(dialog, { key: 'Escape' });
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
      expect(onConfirm).toHaveBeenCalledTimes(1);

      await act(async () => {
        action.resolve();
        await action.promise;
      });
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it('also ignores a close request when the open state is controlled by the owner', async () => {
      const action = deferred();
      const onOpenChange = vi.fn();
      const user = userEvent.setup();
      renderWithTheme(
        <ConfirmDialog
          open
          onOpenChange={onOpenChange}
          title="Reset the demo data?"
          onConfirm={() => action.promise}
        >
          This removes all synthetic cases.
        </ConfirmDialog>,
      );
      const dialog = await screen.findByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
      await waitFor(() =>
        expect(within(dialog).getByRole('button', { name: 'Confirm' })).toBeDisabled(),
      );
      fireEvent.keyDown(dialog, { key: 'Escape' });
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();

      await act(async () => {
        action.resolve();
        await action.promise;
      });
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    });

    it('does not report to its owner or update anything once it has been removed', async () => {
      const action = deferred();
      const onOpenChange = vi.fn();
      const { view } = await startAction(() => action.promise, onOpenChange);
      view.unmount();
      onOpenChange.mockClear();
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await act(async () => {
        action.resolve();
        await action.promise;
      });
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
      errors.mockRestore();
    });

    it('starts the next opening without the message of the last failure', async () => {
      const action = deferred();
      const { user, dialog } = await startAction(() => action.promise);
      await act(async () => {
        action.reject(new Error('Case is locked'));
        await action.promise.catch(() => undefined);
      });
      expect(await within(dialog).findByText('Case is locked')).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

      await user.click(await screen.findByRole('button', { name: 'Delete' }, { timeout: 5000 }));
      const reopened = await screen.findByRole('alertdialog');
      expect(within(reopened).queryByText('Case is locked')).toBeNull();
      expect(within(reopened).getByRole('button', { name: 'Confirm' })).toBeEnabled();
    });
  });
});

describe('CopyButton', () => {
  it('copies the value and announces it politely', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const onCopied = vi.fn();
    renderWithTheme(<CopyButton value="cid-42" label="Copy correlation ID" onCopied={onCopied} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy correlation ID' }));
    });
    expect(writeText).toHaveBeenCalledWith('cid-42');
    expect(onCopied).toHaveBeenCalled();
    expect(await screen.findByText('Copied to clipboard')).toBeInTheDocument();
  });
});
