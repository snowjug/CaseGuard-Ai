import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { expectNoAxeViolations, renderWithTheme } from '../../test/axe';
import { BarChart, summarizeBars } from './BarChart';
import { DeltaBar, computeDelta } from './DeltaBar';
import { LineChart, prepareSeries, summarizeLineChart } from './LineChart';
import { ScoreRing } from './ScoreRing';
import { Sparkline, summarizeSeries } from './Sparkline';
import { StackedBar, segmentShares } from './StackedBar';

const series = [
  {
    id: 'proxy',
    label: 'Proxy misconfiguration',
    points: [
      { x: '2025-03-10T08:00:00Z', y: 0.2, low: 0.1, high: 0.3 },
      { x: '2025-03-11T08:00:00Z', y: 0.45, low: 0.3, high: 0.6 },
      { x: '2025-03-12T08:00:00Z', y: 0.7, low: 0.55, high: 0.85 },
    ],
  },
  {
    id: 'cert',
    label: 'Expired certificate',
    points: [
      { x: '2025-03-10T08:00:00Z', y: 0.4 },
      { x: '2025-03-11T08:00:00Z', y: 0.25 },
      { x: '2025-03-12T08:00:00Z', y: 0.1 },
    ],
  },
] as const;

describe('chart summaries (pure)', () => {
  it('summarises a series with count, ends, trend and range', () => {
    expect(summarizeSeries('CQI', [], String)).toBe('CQI: no data');
    expect(summarizeSeries('CQI', [{ value: 5 }], String)).toBe('CQI: a single value, 5');
    expect(summarizeSeries('CQI', [{ value: 50 }, { value: 60 }, { value: 55 }], String)).toBe(
      'CQI: 3 points, from 50 to 55 (up), lowest 50, highest 60',
    );
  });

  it('drops invalid points and sorts line series by x', () => {
    const prepared = prepareSeries([
      {
        id: 'a',
        label: 'A',
        points: [
          { x: 3, y: 1 },
          { x: 'bad', y: 2 },
          { x: 1, y: 5 },
          { x: 2, y: Number.NaN },
        ],
      },
    ]);
    expect(prepared[0]?.points.map((p) => p.x)).toEqual([1, 3]);
    expect(prepared[0]?.hasBand).toBe(false);
  });

  it('describes line and bar charts including the empty case', () => {
    expect(summarizeLineChart('Confidence', prepareSeries([]), String, String)).toBe(
      'Confidence: no data to plot',
    );
    expect(summarizeBars('Missing evidence', [], String)).toBe('Missing evidence: no data to plot');
    expect(
      summarizeBars(
        'Gaps',
        [
          { key: 'a', label: 'Logs', value: 4 },
          { key: 'b', label: 'Trace', value: 1 },
        ],
        String,
      ),
    ).toContain('Highest Logs, 4. Lowest Trace, 1');
  });

  it('computes shares and deltas without inventing numbers', () => {
    expect(segmentShares([{ value: 1 }, { value: 3 }])).toEqual([25, 75]);
    expect(segmentShares([{ value: 1 }], 4)).toEqual([25]);
    expect(segmentShares([], 0)).toEqual([]);
    expect(computeDelta(100, 60, 'lower')).toEqual({ delta: -40, percent: -40, verdict: 'better' });
    expect(computeDelta(100, 130, 'lower').verdict).toBe('worse');
    expect(computeDelta(50, 70, 'higher').verdict).toBe('better');
    expect(computeDelta(0, 5, 'lower').percent).toBeNull();
    expect(computeDelta(5, 5, 'lower').verdict).toBe('no change');
  });
});

describe('[NFR-A11Y-01] Sparkline', () => {
  it('exposes a summary as an image and the data as a hidden table', () => {
    renderWithTheme(<Sparkline label="CQI over six runs" values={[52, 55, 53, 58, 60, 61]} />);
    const image = screen.getByRole('img', {
      name: /CQI over six runs: 6 points, from 52 to 61 \(up\)/,
    });
    expect(image).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(7);
  });

  it('is safe with no data and with a single point', () => {
    const { rerender, container } = renderWithTheme(<Sparkline label="Trend" values={[]} />);
    expect(screen.getByRole('img', { name: 'Trend: no data' })).toBeInTheDocument();
    expect(container.querySelector('path')).toBeNull();
    rerender(<Sparkline label="Trend" values={[7]} />);
    expect(container.querySelector('circle')).not.toBeNull();
  });
});

describe('[NFR-A11Y-01] LineChart', () => {
  it('has a text alternative, a data table with a row per timestamp and band columns', async () => {
    const { container } = renderWithTheme(
      <LineChart
        title="Hypothesis confidence over time"
        series={series}
        yDomain={[0, 1]}
        yFormat={(n) => `${Math.round(n * 100)}%`}
        events={[{ x: '2025-03-11T08:00:00Z', label: 'Escalation' }]}
        bandLabel="Confidence range"
      />,
    );
    expect(
      screen.getByRole('img', {
        name: /Hypothesis confidence over time\. Proxy misconfiguration: 3 points from 20% .* rising/,
      }),
    ).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 3 + 1);
    expect(within(table).getByText('Proxy misconfiguration low')).toBeInTheDocument();
    // Patterns, not only colour: the band is hatched and series carry distinct dashes and markers.
    expect(container.querySelector('pattern')).not.toBeNull();
    expect(container.querySelector('path[fill^="url(#"]')).not.toBeNull();
    expect(container.querySelector('path[stroke-dasharray]')).not.toBeNull();
    expect(screen.getByText('Confidence range')).toBeInTheDocument();
    expect(screen.getAllByText(/Escalation/).length).toBeGreaterThan(0);
    await expectNoAxeViolations(container);
  });

  it('lets keyboard users inspect values with arrow keys', async () => {
    const user = userEvent.setup();
    renderWithTheme(<LineChart title="Confidence" series={series} yFormat={(n) => n.toFixed(2)} />);
    const inspector = screen.getByRole('slider', { name: /Inspect values: Confidence/ });
    await user.tab();
    expect(inspector).toHaveFocus();
    expect(inspector).toHaveAttribute('aria-valuenow', '2');
    await user.keyboard('{ArrowLeft}');
    expect(inspector).toHaveAttribute('aria-valuenow', '1');
    expect(inspector.getAttribute('aria-valuetext')).toMatch(
      /11 Mar.*Proxy misconfiguration 0\.45.*Expired certificate 0\.25/,
    );
    await user.keyboard('{Home}');
    expect(inspector).toHaveAttribute('aria-valuenow', '0');
    await user.keyboard('{Escape}');
    expect(inspector.getAttribute('aria-valuetext')).toMatch(/arrow keys/);
  });

  it('handles empty data and a single point without crashing', () => {
    const { rerender, container } = renderWithTheme(<LineChart title="Empty" series={[]} />);
    expect(screen.getByRole('img', { name: 'Empty: no data to plot' })).toBeInTheDocument();
    expect(screen.getByText('No data to plot yet')).toBeInTheDocument();
    rerender(
      <LineChart title="One" series={[{ id: 's', label: 'S', points: [{ x: 1, y: 3 }] }]} />,
    );
    expect(screen.getByRole('img', { name: /S: one value, 3 at 1/ })).toBeInTheDocument();
    expect(container.querySelector('svg path[d^="M"]')).not.toBeNull();
    expect(screen.queryByRole('slider')).toBeNull();
  });
});

describe('[NFR-A11Y-01] BarChart', () => {
  const data = [
    { key: 'logs', label: 'Sign-in logs', value: 8, tone: 'evidence' as const },
    {
      key: 'trace',
      label: 'Client trace from an affected device',
      value: 5,
      low: 3,
      high: 6,
      tone: 'uncertain' as const,
    },
    {
      key: 'sim',
      label: 'Simulated extra evidence',
      value: 2,
      tone: 'simulated' as const,
      note: 'Estimate',
    },
  ];

  it('summarises, tabulates and distinguishes bars by pattern as well as colour', async () => {
    const { container } = renderWithTheme(
      <BarChart title="Missing evidence by type" data={data} />,
    );
    expect(
      screen.getByRole('img', {
        name: /Missing evidence by type: 3 bars\. Highest Sign-in logs, 8/,
      }),
    ).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(4);
    const fills = [...container.querySelectorAll('rect[rx="3"]')].map((r) =>
      r.getAttribute('fill'),
    );
    expect(fills.some((f) => f?.startsWith('url(#'))).toBe(true);
    expect(fills.some((f) => f?.startsWith('var('))).toBe(true);
    await expectNoAxeViolations(container);
  });

  it('lets keyboard users step through bars', async () => {
    const user = userEvent.setup();
    renderWithTheme(<BarChart title="Missing evidence" data={data} />);
    const inspector = screen.getByRole('slider', { name: /Inspect bars/ });
    await user.tab();
    await user.keyboard('{ArrowUp}');
    expect(inspector.getAttribute('aria-valuetext')).toMatch(/Client trace.*5, range 3 to 6/);
  });

  it('is safe with empty and single-bar data and supports vertical bars', () => {
    const { rerender } = renderWithTheme(<BarChart title="Empty" data={[]} />);
    expect(screen.getByText('No data to plot yet')).toBeInTheDocument();
    rerender(
      <BarChart
        title="One"
        data={[{ key: 'a', label: 'Only', value: 3 }]}
        orientation="vertical"
      />,
    );
    expect(screen.getByRole('img', { name: 'One: one bar, Only 3' })).toBeInTheDocument();
  });
});

describe('[NFR-A11Y-01] StackedBar, ScoreRing and DeltaBar', () => {
  it('StackedBar states every part with its value and share, with patterns for each part', async () => {
    const { container } = renderWithTheme(
      <StackedBar
        title="Where the avoidable effort comes from"
        segments={[
          { key: 'a', label: 'Engineer effort', value: 40 },
          { key: 'b', label: 'Customer effort', value: 35 },
          { key: 'c', label: 'Waiting time', value: 25 },
        ]}
        total={120}
        valueFormat={(n) => `${n} h`}
      />,
    );
    expect(
      screen.getByRole('img', {
        name: /Engineer effort 33%, Customer effort 29%, Waiting time 21%, remainder 17%/,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/40 h · 33%/)).toBeInTheDocument();
    expect(screen.getByText('Remainder')).toBeInTheDocument();
    expect(container.querySelectorAll('pattern').length).toBeGreaterThan(0);
    await expectNoAxeViolations(container);
  });

  it('StackedBar handles no data', () => {
    renderWithTheme(<StackedBar title="Nothing yet" segments={[]} />);
    expect(screen.getByRole('img', { name: 'Nothing yet: no data to plot' })).toBeInTheDocument();
  });

  it('ScoreRing states the score, status in words and the estimated range', async () => {
    const { container } = renderWithTheme(
      <ScoreRing
        label="Case Quality Index"
        value={72}
        low={64}
        high={80}
        status="watch"
        caption="Estimated"
      />,
    );
    expect(
      screen.getByRole('img', {
        name: 'Case Quality Index: 72 out of 100, Watch, estimated range 64 to 80',
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Watch').length).toBeGreaterThan(0);
    await expectNoAxeViolations(container);
  });

  it('ScoreRing is safe without a value', () => {
    renderWithTheme(<ScoreRing label="Resolution Confidence" value={null} />);
    expect(screen.getByRole('img', { name: /not enough data/ })).toBeInTheDocument();
  });

  it('DeltaBar labels the simulated bar and states the difference in words', async () => {
    const { container } = renderWithTheme(
      <DeltaBar
        label="Time to diagnosis"
        actual={2160}
        counterfactual={720}
        counterfactualLow={600}
        counterfactualHigh={900}
        format={(n) => `${Math.round(n / 60)} h`}
      />,
    );
    expect(
      screen.getByRole('img', {
        name: /Actual 36 h; Simulated 12 h, estimated range 10 h to 15 h; better, -24 h \(-67%\)/,
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Simulated').length).toBeGreaterThan(0);
    expect(container.querySelector('pattern')).not.toBeNull();
    await expectNoAxeViolations(container);
  });
});

describe('chart tables are reachable for screen readers only', () => {
  it('keeps the table in the DOM but out of sight', () => {
    renderWithTheme(<Sparkline label="x" values={[1, 2]} />);
    const table = screen.getByRole('table');
    fireEvent.focus(table);
    expect(table).toBeInTheDocument();
  });
});
