import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations, renderWithTheme } from '../../test/axe';
import { installMatchMedia } from '../../test/media';
import { makeGraph, makeNode, sampleGraph } from '../../test/graph-fixtures';
import { InvestigationGraphView } from './InvestigationGraphView';
import { PathComparison } from './PathComparison';

const nodeButton = (name: RegExp | string): HTMLElement => screen.getByRole('button', { name });
const zoomLabel = (): string => screen.getByLabelText(/^Zoom \d+%$/).textContent ?? '';

describe('[FR-UX-02] InvestigationGraphView', () => {
  it('renders every node as a labelled button and exactly one is in the tab order (roving tabindex)', () => {
    const graph = sampleGraph();
    const { container } = renderWithTheme(<InvestigationGraphView graph={graph} />);
    const nodes = container.querySelectorAll('[data-node-id]');
    expect(nodes).toHaveLength(graph.nodes.length);
    expect(container.querySelectorAll('[data-node-id][tabindex="0"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-node-id][tabindex="-1"]')).toHaveLength(
      graph.nodes.length - 1,
    );
    for (const node of nodes) expect(node.getAttribute('aria-label')).toBeTruthy();
    // role=application would be wrong for the whole graph: it is a labelled group of buttons.
    expect(container.querySelector('[role="application"]')).toBeNull();
    expect(
      screen.getByRole('group', { name: /Investigation graph with 16 nodes and 11 connections/ }),
    ).toBeInTheDocument();
  });

  it('never relies on colour alone: statuses and simulation are named in the accessible label', () => {
    renderWithTheme(<InvestigationGraphView graph={sampleGraph()} />);
    expect(
      nodeButton(/Evidence: Missing: client trace from an affected device\. Missing/),
    ).toBeInTheDocument();
    const simulated = nodeButton(
      /Simulated step: Capture proxy trace for one affected user\. Productive\. Simulated, not something that happened/,
    );
    expect(simulated).toHaveAttribute('data-simulated', 'true');
    expect(
      nodeButton(
        /Hypothesis: Proxy authentication misconfiguration\. Uncertain\. Confidence 55%, a model estimate/,
      ),
    ).toBeInTheDocument();
  });

  it('moves focus to the nearest neighbour with the arrow keys and selects with Enter, clears with Escape', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderWithTheme(<InvestigationGraphView graph={sampleGraph()} onSelect={onSelect} />);

    await user.tab(); // toolbar buttons come first
    nodeButton(/Problem: Users cannot sign in/).focus();
    expect(nodeButton(/Problem: Users cannot sign in/)).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(nodeButton(/Evidence: Sign-in errors begin/)).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(nodeButton(/Evidence: Customer reports a recent proxy update/)).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(nodeButton(/Evidence: Sign-in errors begin/)).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(nodeButton(/Problem:/)).toHaveFocus();

    await user.keyboard('{ArrowDown}{ArrowRight}{Enter}');
    expect(onSelect).toHaveBeenLastCalledWith('ev2');
    await user.keyboard('{Escape}');
    expect(onSelect).toHaveBeenLastCalledWith(null);
    await user.keyboard(' ');
    expect(onSelect).toHaveBeenLastCalledWith('ev2');
  });

  it('keeps the roving tab stop on the node that last had focus', async () => {
    const user = userEvent.setup();
    const { container } = renderWithTheme(<InvestigationGraphView graph={sampleGraph()} />);
    nodeButton(/Problem:/).focus();
    await user.keyboard('{ArrowDown}');
    const tabbable = container.querySelector('[data-node-id][tabindex="0"]');
    expect(tabbable).toBe(nodeButton(/Evidence: Sign-in errors begin/));
  });

  it('zooms with + and - and fits with 0 while a node has focus', async () => {
    const user = userEvent.setup();
    renderWithTheme(<InvestigationGraphView graph={sampleGraph()} />);
    nodeButton(/Problem:/).focus();
    const initial = Number.parseInt(zoomLabel(), 10);
    await user.keyboard('+');
    const zoomedIn = Number.parseInt(zoomLabel(), 10);
    expect(zoomedIn).toBeGreaterThan(initial);
    await user.keyboard('--');
    expect(Number.parseInt(zoomLabel(), 10)).toBeLessThan(zoomedIn);
    await user.keyboard('0');
    expect(Number.parseInt(zoomLabel(), 10)).toBeGreaterThan(0);
  });

  it('has zoom, fit, focus and reset controls as buttons', async () => {
    const user = userEvent.setup();
    renderWithTheme(<InvestigationGraphView graph={sampleGraph()} selectedId="fork" />);
    const toolbar = screen.getByRole('toolbar', { name: 'Graph controls' });
    const before = Number.parseInt(zoomLabel(), 10);
    await user.click(within(toolbar).getByRole('button', { name: 'Zoom in' }));
    expect(Number.parseInt(zoomLabel(), 10)).toBeGreaterThan(before);
    await user.click(within(toolbar).getByRole('button', { name: 'Fit whole graph' }));
    await user.click(within(toolbar).getByRole('button', { name: 'Focus the selected node' }));
    expect(Number.parseInt(zoomLabel(), 10)).toBeGreaterThanOrEqual(100);
    await user.click(within(toolbar).getByRole('button', { name: 'Reset view' }));
  });

  it('marks the selected node with aria-pressed', () => {
    renderWithTheme(<InvestigationGraphView graph={sampleGraph()} selectedId="fork" />);
    expect(nodeButton(/Decision fork: Reinstall chosen/)).toHaveAttribute('aria-pressed', 'true');
    expect(nodeButton(/Problem:/)).toHaveAttribute('aria-pressed', 'false');
  });

  it('draws solid actual edges and dashed hatched simulated edges, with a legend that says Simulated', () => {
    const { container } = renderWithTheme(<InvestigationGraphView graph={sampleGraph()} />);
    const actual = container.querySelector('g[data-edge-kind="actual"]');
    const simulated = container.querySelector(
      'g[data-simulated="true"][data-edge-kind="branches"]',
    );
    expect(actual?.querySelector('path[stroke-dasharray]')).toBeNull();
    expect(simulated?.querySelectorAll('path')).toHaveLength(2);
    expect(simulated?.querySelector('path[stroke-dasharray]')).not.toBeNull();
    expect(simulated?.querySelector('path[stroke^="url(#"]')).not.toBeNull();
    expect(container.querySelectorAll('marker').length).toBeGreaterThan(2);
    const legend = screen.getByRole('group', { name: 'Graph legend' });
    expect(within(legend).getByText(/Simulated path \(dashed, hatched\)/)).toBeInTheDocument();
    expect(within(legend).getByText('Decision fork')).toBeInTheDocument();
  });

  it('provides a text alternative with the summary paragraph, a node table and an edge table', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const graph = sampleGraph();
    renderWithTheme(<InvestigationGraphView graph={graph} onSelect={onSelect} />);
    const details = screen.getByText(/Text alternative/).closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByText(graph.summary)).toBeInTheDocument();
    const [nodes, edges] = within(details).getAllByRole('table');
    expect(within(nodes as HTMLElement).getAllByRole('row')).toHaveLength(graph.nodes.length + 1);
    expect(within(edges as HTMLElement).getAllByRole('row')).toHaveLength(graph.edges.length + 1);
    await user.click(
      within(nodes as HTMLElement).getByRole('button', { name: 'Select: Resolved after 9 days' }),
    );
    expect(onSelect).toHaveBeenCalledWith('out1');
  });

  it('highlights the divergence at the fork in compare mode only', () => {
    const { rerender } = renderWithTheme(
      <InvestigationGraphView graph={sampleGraph()} mode="compare" />,
    );
    expect(screen.getByText('Paths diverge at this fork')).toBeInTheDocument();
    rerender(<InvestigationGraphView graph={sampleGraph()} mode="actual" />);
    expect(screen.queryByText('Paths diverge at this fork')).toBeNull();
  });

  it('shows only the real path in actual mode and drops the late actual path in counterfactual mode', () => {
    const { container, rerender } = renderWithTheme(
      <InvestigationGraphView graph={sampleGraph()} mode="actual" />,
    );
    expect(container.querySelectorAll('[data-simulated="true"][data-node-id]')).toHaveLength(0);
    rerender(<InvestigationGraphView graph={sampleGraph()} mode="counterfactual" />);
    expect(screen.queryByRole('button', { name: /Escalate to the network team/ })).toBeNull();
    expect(nodeButton(/Simulated step: Capture proxy trace/)).toBeInTheDocument();
  });

  it('falls back to the accessible list below 640 px', () => {
    installMatchMedia((query) => query === '(max-width: 639px)');
    const graph = sampleGraph();
    const { container } = renderWithTheme(<InvestigationGraphView graph={graph} />);
    expect(container.querySelector('svg[role="group"]')).toBeNull();
    expect(
      screen.getByText(/The interactive canvas is available on wider screens/),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('table')).toHaveLength(2);
    expect(screen.getByText(graph.summary)).toBeInTheDocument();
  });

  it('shows an empty state instead of a blank canvas when the graph has no nodes', () => {
    renderWithTheme(<InvestigationGraphView graph={makeGraph([], [])} />);
    expect(screen.getByText('No graph yet')).toBeInTheDocument();
  });

  it('tells the person when a graph was truncated', () => {
    renderWithTheme(
      <InvestigationGraphView
        graph={makeGraph([makeNode({ id: 'a', lane: 'problem', order: 0 })], [], {
          truncated: true,
          nodeLimit: 160,
        })}
      />,
    );
    expect(screen.getByText('Large graph')).toBeInTheDocument();
  });

  it('turns transitions off when reduced motion is requested', () => {
    window.localStorage.setItem('cg-reduced-motion', 'reduce');
    const { container } = renderWithTheme(<InvestigationGraphView graph={sampleGraph()} />);
    const viewport = [...container.querySelectorAll('svg > g')].find((g) =>
      (g as SVGGElement).style.transform.includes('scale'),
    );
    expect((viewport as SVGGElement).style.transition).toBe('none');
  });

  it('passes axe on desktop and in list view', async () => {
    const { container, unmount } = renderWithTheme(
      <InvestigationGraphView graph={sampleGraph()} selectedId="s1" />,
    );
    await expectNoAxeViolations(container);
    unmount();
    installMatchMedia((query) => query === '(max-width: 639px)');
    const list = renderWithTheme(<InvestigationGraphView graph={sampleGraph()} />);
    await expectNoAxeViolations(list.container);
  });

  it('does not lose the selection callback when the background is clicked', async () => {
    const onSelect = vi.fn();
    const { container } = renderWithTheme(
      <InvestigationGraphView graph={sampleGraph()} selectedId="fork" onSelect={onSelect} />,
    );
    const background = container.querySelector('rect[role="presentation"]') as SVGRectElement;
    await act(async () => {
      background.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }),
      );
      background.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: 10, clientY: 10 }),
      );
    });
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});

describe('PathComparison', () => {
  const props = {
    actual: {
      label: 'Actual path',
      totalMinutes: 12960,
      steps: [
        {
          id: 'a1',
          label: 'Request sign-in logs',
          durationMinutes: 240,
          status: 'productive' as const,
        },
        {
          id: 'a2',
          label: 'Ask the customer to reinstall the client',
          durationMinutes: 2880,
          status: 'unsupported' as const,
        },
        {
          id: 'fork',
          label: 'Reinstall chosen before checking the proxy',
          durationMinutes: 60,
          kind: 'fork' as const,
        },
        { id: 'a3', label: 'Escalate to the network team', durationMinutes: 5760 },
        { id: 'a4', label: 'Resolved', durationMinutes: 4020, kind: 'outcome' as const },
      ],
    },
    counterfactual: {
      label: 'Simulated path',
      steps: [
        {
          id: 's1',
          label: 'Capture proxy trace',
          durationMinutes: 120,
          status: 'productive' as const,
        },
        { id: 's2', label: 'Compare authentication settings', durationMinutes: 240 },
        { id: 's3', label: 'Resolved', durationMinutes: 600, kind: 'outcome' as const },
      ],
    },
    forkStepId: 'fork',
    forkLabel: 'reinstall before checking the proxy',
    metrics: [
      {
        key: 'ttd',
        label: 'Time to diagnosis',
        actual: 12960,
        counterfactual: 4320,
        low: 3600,
        high: 5400,
        format: (n: number) => `${Math.round(n / 60)} h`,
      },
    ],
  };

  it('draws two tracks with a fork, a duration scale and an actual-versus-simulated metric strip', async () => {
    const { container } = renderWithTheme(<PathComparison {...props} />);
    expect(
      screen.getByRole('img', {
        name: /Actual path: 5 steps, 9 d in total\. Simulated path \(simulated\): 3 steps/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('img', {
        name: /The paths diverge after step 3, reinstall before checking the proxy/,
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Decision fork').length).toBeGreaterThan(0);
    expect(screen.getByText('Elapsed time')).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: 'Metric differences between actual and simulated paths' }),
    ).toBeInTheDocument();
    // Solid connectors for actual, dashed for simulated.
    expect(container.querySelectorAll('line[stroke-dasharray="8 5"]').length).toBeGreaterThan(0);
    expect(container.querySelector('pattern')).not.toBeNull();
    expect(
      within(
        screen.getByRole('table', { name: /Actual path compared with the simulated alternative/ }),
      ).getAllByRole('row'),
    ).toHaveLength(1 + 5 + 3);
    await expectNoAxeViolations(container);
  });

  it('works without a fork, without durations and without metrics', () => {
    renderWithTheme(
      <PathComparison
        actual={{ label: 'Actual path', steps: [{ id: 'a', label: 'Only step' }] }}
        counterfactual={{ label: 'Simulated path', steps: [] }}
      />,
    );
    expect(
      screen.getByText('Step durations are not available for these paths.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /Metric differences/ })).toBeNull();
  });
});
