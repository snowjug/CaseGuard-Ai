import { METRIC_DEFINITIONS, type MetricCard, type MetricKey } from '@caseguard/schemas';
import type {
  BarDatum,
  LineSeries,
  PathMetricDelta,
  PathTrack,
  StackedSegment,
  TimeCursorMarker,
} from '@caseguard/ui';

/**
 * STATIC SAMPLE DATA for the development-only design lab (see `sample-graph.ts`). Numbers are invented for visual
 * verification only and must never appear in a product page.
 */

function metric(
  key: MetricKey,
  fields: Partial<MetricCard> & Pick<MetricCard, 'value' | 'display' | 'status'>,
): MetricCard {
  const definition = METRIC_DEFINITIONS[key];
  return {
    key,
    label: definition.label,
    unit: definition.unit,
    trend: null,
    definition: definition.definition,
    formula: definition.formula,
    range: null,
    estimated: true,
    synthetic: true,
    evidenceLink: { href: '#metrics', label: 'See the evidence' },
    caseId: 'design-lab-sample',
    ...fields,
  };
}

export const SAMPLE_CQI_METRIC: MetricCard = metric('case_quality_index', {
  value: 72,
  display: '72',
  status: 'watch',
  trend: { direction: 'up', delta: 6, label: 'vs the previous analysis' },
  range: { low: 66, high: 78 },
});

export const SAMPLE_METRICS: MetricCard[] = [
  SAMPLE_CQI_METRIC,
  metric('evidence_integrity', {
    value: 86,
    display: '86',
    status: 'good',
    trend: { direction: 'flat', delta: 0, label: 'unchanged' },
    range: { low: 80, high: 91 },
  }),
  metric('avoidable_support_effort', {
    value: 38,
    display: '38%',
    status: 'watch',
    trend: { direction: 'up', delta: 4, label: 'vs the previous analysis' },
    range: { low: 31, high: 45 },
  }),
  metric('reasoning_efficiency', {
    value: 54,
    display: '54',
    status: 'poor',
    trend: { direction: 'down', delta: -5, label: 'vs the previous analysis' },
    range: { low: 47, high: 61 },
  }),
  metric('customer_effort', {
    value: 41,
    display: '41 min',
    status: 'watch',
    range: { low: 35, high: 48 },
  }),
  metric('resolution_confidence', {
    value: null,
    display: 'Not enough data',
    status: 'unknown',
    evidenceLink: null,
  }),
  metric('token_efficiency', {
    value: 7.4,
    display: '7.4 bits/1k tokens',
    status: 'good',
    synthetic: false,
    range: { low: 6.1, high: 8.6 },
    evidenceLink: null,
  }),
];

export const SAMPLE_CQI_HISTORY = [48, 52, 55, 61, 58, 66, 72];

const DAY = 86_400_000;
const T0 = Date.UTC(2025, 2, 3);
const at = (day: number): string => new Date(T0 + day * DAY).toISOString();

export const SAMPLE_LINE_SERIES: LineSeries[] = [
  {
    id: 'h1',
    label: 'Proxy authentication misconfiguration',
    points: [
      { x: at(0), y: 0.34, low: 0.18, high: 0.5 },
      { x: at(1), y: 0.45, low: 0.3, high: 0.6 },
      { x: at(3), y: 0.58, low: 0.44, high: 0.72 },
      { x: at(6), y: 0.49, low: 0.35, high: 0.63 },
      { x: at(8), y: 0.41, low: 0.28, high: 0.54 },
    ],
  },
  {
    id: 'h4',
    label: 'PAC file routes sign-in through the wrong proxy',
    points: [
      { x: at(0), y: 0.08, low: 0.02, high: 0.14 },
      { x: at(3), y: 0.15, low: 0.07, high: 0.23 },
      { x: at(6), y: 0.52, low: 0.4, high: 0.64 },
      { x: at(8), y: 0.64, low: 0.52, high: 0.76 },
    ],
  },
  {
    id: 'h2',
    label: 'Expired client certificate',
    points: [
      { x: at(0), y: 0.3 },
      { x: at(1), y: 0.22 },
      { x: at(3), y: 0.12 },
      { x: at(6), y: 0.06 },
    ],
  },
];

export const SAMPLE_LINE_EVENTS = [
  { x: at(3), label: 'Decision fork: reinstall chosen' },
  { x: at(6), label: 'Escalation to the network team' },
];

export const SAMPLE_BARS: BarDatum[] = [
  {
    key: 'b1',
    label: 'Repeated information requests',
    value: 34,
    low: 26,
    high: 42,
    tone: 'unsupported',
  },
  { key: 'b2', label: 'Waiting for the customer', value: 27, low: 20, high: 33, tone: 'uncertain' },
  { key: 'b3', label: 'Escalation delay', value: 22, low: 15, high: 29, tone: 'brand' },
  {
    key: 'b4',
    label: 'Unproductive reinstall',
    value: 12,
    tone: 'unsupported',
    note: 'Not supported by evidence',
  },
  {
    key: 'b5',
    label: 'Simulated: capture a proxy trace first',
    value: 6,
    tone: 'simulated',
    note: 'Simulated alternative',
  },
];

export const SAMPLE_STACKED: StackedSegment[] = [
  { key: 's1', label: 'Productive effort', value: 44, tone: 'productive', pattern: 'solid' },
  { key: 's2', label: 'Necessary waiting', value: 18, tone: 'brand', pattern: 'outline' },
  { key: 's3', label: 'Uncertain value', value: 14, tone: 'uncertain', pattern: 'dots' },
  { key: 's4', label: 'Avoidable effort', value: 24, tone: 'unsupported', pattern: 'crosshatch' },
];

export const SAMPLE_TIME_MIN = '2025-03-03T08:00:00Z';
export const SAMPLE_TIME_MAX = '2025-03-12T17:30:00Z';
export const SAMPLE_TIME_MARKERS: TimeCursorMarker[] = [
  { at: '2025-03-03T08:02:00Z', label: 'First failure reported' },
  { at: '2025-03-06T11:15:00Z', label: 'Reinstall requested' },
  { at: '2025-03-09T14:40:00Z', label: 'Escalated' },
  { at: '2025-03-12T09:05:00Z', label: 'Resolved' },
];

export interface SampleCaseRow {
  id: string;
  reference: string;
  title: string;
  severity: 'A' | 'B' | 'C';
  quality: number | null;
  warnings: number;
  state: 'Analysed' | 'Analysing' | 'Not analysed';
}

export const SAMPLE_CASE_ROWS: SampleCaseRow[] = [
  {
    id: 'r1',
    reference: 'SAMPLE-001',
    title: 'Intermittent sign-in failures after a proxy change',
    severity: 'B',
    quality: 72,
    warnings: 3,
    state: 'Analysed',
  },
  {
    id: 'r2',
    reference: 'SAMPLE-002',
    title: 'Mailbox migration stalls at 80 percent',
    severity: 'A',
    quality: 91,
    warnings: 0,
    state: 'Analysed',
  },
  {
    id: 'r3',
    reference: 'SAMPLE-003',
    title: 'Reports fail to refresh on schedule',
    severity: 'C',
    quality: null,
    warnings: 0,
    state: 'Not analysed',
  },
  {
    id: 'r4',
    reference: 'SAMPLE-004',
    title: 'Gateway timeouts during the nightly batch',
    severity: 'B',
    quality: 58,
    warnings: 5,
    state: 'Analysing',
  },
];

const formatDays = (minutes: number): string => `${(minutes / 1440).toFixed(1)} days`;

export const SAMPLE_ACTUAL_TRACK: PathTrack = {
  label: 'Actual path',
  totalMinutes: 9 * 1440,
  steps: [
    {
      id: 'a1',
      label: 'Request sign-in logs',
      kind: 'action',
      status: 'productive',
      durationMinutes: 240,
    },
    {
      id: 'a2',
      label: 'Ask about recent changes',
      kind: 'action',
      status: 'productive',
      durationMinutes: 1440,
    },
    {
      id: 'a3',
      label: 'Ask for a client reinstall',
      kind: 'action',
      status: 'unsupported',
      durationMinutes: 2880,
    },
    {
      id: 'f1',
      label: 'Reinstall before checking the proxy',
      kind: 'fork',
      status: 'uncertain',
      durationMinutes: 120,
    },
    {
      id: 'a4',
      label: 'Request the same logs again',
      kind: 'action',
      status: 'unsupported',
      durationMinutes: 2160,
    },
    {
      id: 'a5',
      label: 'Escalate to the network team',
      kind: 'action',
      status: 'neutral',
      durationMinutes: 1440,
    },
    {
      id: 'a6',
      label: 'Correct the PAC file',
      kind: 'action',
      status: 'productive',
      durationMinutes: 4320,
    },
    { id: 'o1', label: 'Resolved', kind: 'outcome', status: 'neutral', durationMinutes: 360 },
  ],
};

export const SAMPLE_SIMULATED_TRACK: PathTrack = {
  label: 'Simulated path',
  totalMinutes: 3 * 1440,
  steps: [
    {
      id: 'c1',
      label: 'Capture a proxy trace',
      kind: 'action',
      status: 'productive',
      durationMinutes: 480,
    },
    {
      id: 'c2',
      label: 'Compare authentication settings',
      kind: 'action',
      status: 'productive',
      durationMinutes: 720,
    },
    {
      id: 'c3',
      label: 'Correct the PAC file',
      kind: 'action',
      status: 'productive',
      durationMinutes: 1200,
    },
    {
      id: 'c4',
      label: 'Simulated: resolved',
      kind: 'outcome',
      status: 'productive',
      durationMinutes: 240,
    },
  ],
};

export const SAMPLE_PATH_METRICS: PathMetricDelta[] = [
  {
    key: 'time',
    label: 'Time to diagnosis',
    actual: 9 * 1440,
    counterfactual: 3 * 1440,
    low: 2 * 1440,
    high: 4.5 * 1440,
    format: formatDays,
  },
  {
    key: 'contacts',
    label: 'Customer contacts',
    actual: 7,
    counterfactual: 4,
    low: 3,
    high: 5,
    format: (n) => `${n}`,
  },
  {
    key: 'confidence',
    label: 'Resolution confidence',
    actual: 54,
    counterfactual: 71,
    low: 60,
    high: 80,
    better: 'higher',
    format: (n) => `${n}%`,
  },
];
