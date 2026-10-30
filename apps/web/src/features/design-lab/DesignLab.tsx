'use client';

import {
  BADGE_STATUSES,
  BarChart,
  ConfidenceBand,
  ConfirmDialog,
  CopyButton,
  DataTable,
  DeltaBar,
  DefinitionPopover,
  EmptyState,
  ErrorState,
  HelpButton,
  InvestigationGraphView,
  KeyValueList,
  LineChart,
  LoadingSkeleton,
  MetricCard,
  Notice,
  PageHeader,
  Panel,
  PathComparison,
  ProvenanceBadge,
  RangeBar,
  ScoreRing,
  SectionHeader,
  Sparkline,
  StackedBar,
  StatusBadge,
  SvgPatternDefs,
  TONE_NAMES,
  TimeCursor,
  VisuallyHidden,
  caseguardDarkTheme,
  caseguardLightTheme,
  cg,
  formatDateTimeUtc,
  formatNumber,
  patternUrl,
  useReducedMotionPreference,
  useThemeMode,
  type DataTableColumn,
  type GraphMode,
  type ThemeMode,
} from '@caseguard/ui';
import {
  Button,
  FluentProvider,
  Switch,
  ToggleButton,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { DeleteRegular, FolderRegular } from '@fluentui/react-icons';
import { useId, useState, type ReactNode } from 'react';
import {
  SAMPLE_ACTUAL_TRACK,
  SAMPLE_BARS,
  SAMPLE_CASE_ROWS,
  SAMPLE_CQI_HISTORY,
  SAMPLE_CQI_METRIC,
  SAMPLE_LINE_EVENTS,
  SAMPLE_LINE_SERIES,
  SAMPLE_METRICS,
  SAMPLE_PATH_METRICS,
  SAMPLE_SIMULATED_TRACK,
  SAMPLE_STACKED,
  SAMPLE_TIME_MARKERS,
  SAMPLE_TIME_MAX,
  SAMPLE_TIME_MIN,
  type SampleCaseRow,
} from './samples';
import { SAMPLE_GRAPH } from './sample-graph';

const useStyles = makeStyles({
  page: {
    maxWidth: '1440px',
    marginInline: 'auto',
    padding: `${cg.space[6]} ${cg.space[6]} ${cg.space[8]}`,
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[8],
  },
  topbar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${cg.space[3]} ${cg.space[6]}`,
    padding: `${cg.space[3]} ${cg.space[4]}`,
    borderRadius: cg.radius.lg,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surface,
  },
  group: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: cg.space[2] },
  groupLabel: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.textSecondary,
  },
  toc: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: `${cg.space[1]} ${cg.space[4]}`,
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  tocLink: {
    color: cg.textLink,
    fontSize: tokens.fontSizeBase300,
    textDecorationLine: 'none',
    ':hover': { textDecorationLine: 'underline' },
  },
  section: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[3] },
  grid: {
    display: 'grid',
    gap: cg.space[4],
    gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
  },
  grid2: {
    display: 'grid',
    gap: cg.space[4],
    gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
  },
  specimen: { display: 'flex', flexDirection: 'column', gap: cg.space[2], minWidth: 0 },
  specimenLabel: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.textSecondary,
  },
  swatchGrid: {
    display: 'grid',
    gap: cg.space[3],
    gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
  },
  swatch: {
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
    borderRadius: cg.radius.md,
    overflow: 'hidden',
    border: `1px solid ${cg.borderSubtle}`,
  },
  swatchCell: {
    padding: `${cg.space[2]} ${cg.space[3]}`,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
  },
  pair: {
    display: 'grid',
    gap: cg.space[4],
    gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))',
  },
  themeBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    padding: cg.space[4],
    borderRadius: cg.radius.lg,
    border: `1px solid ${cg.borderSubtle}`,
  },
  graphWrap: {
    display: 'grid',
    gap: cg.space[4],
    gridTemplateColumns: 'minmax(0, 1fr)',
    '@media (min-width: 1280px)': { gridTemplateColumns: 'minmax(0, 1fr) 320px' },
  },
  detail: { display: 'flex', flexDirection: 'column', gap: cg.space[2] },
  mono: { fontFamily: cg.font.mono, fontSize: tokens.fontSizeBase200 },
  typeSample: { margin: 0 },
});

interface SectionProps {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}

function Section({ id, title, description, children }: SectionProps) {
  const styles = useStyles();
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={styles.section}>
      <SectionHeader id={`${id}-title`} title={title} {...(description ? { description } : {})} />
      {children}
    </section>
  );
}

function Specimen({ label, children }: { label: string; children: ReactNode }) {
  const styles = useStyles();
  return (
    <div className={styles.specimen}>
      <p className={styles.specimenLabel}>{label}</p>
      {children}
    </div>
  );
}

/** Renders the same children in a light and a dark theme at once, for side-by-side contrast checks. */
function ThemePair({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return (
    <div className={styles.pair}>
      {(['light', 'dark'] as const).map((name) => (
        <FluentProvider
          key={name}
          theme={name === 'light' ? caseguardLightTheme : caseguardDarkTheme}
          className={styles.themeBox}
          style={{ backgroundColor: 'var(--cgCanvas)', color: 'var(--cgText)' }}
        >
          <h3 style={{ margin: 0, fontSize: tokens.fontSizeBase400 }}>
            {name === 'light' ? 'Light theme' : 'Dark theme'}
          </h3>
          {children}
        </FluentProvider>
      ))}
    </div>
  );
}

const THEME_LABELS: Record<ThemeMode, string> = { light: 'Light', dark: 'Dark', system: 'System' };

function Controls() {
  const styles = useStyles();
  const { mode, setMode, resolved } = useThemeMode();
  const [motion, setMotion] = useReducedMotionPreference();
  return (
    <div className={styles.topbar} role="group" aria-label="Design lab controls">
      <div className={styles.group}>
        <span className={styles.groupLabel} id="lab-theme-label">
          Theme ({resolved})
        </span>
        <div role="group" aria-labelledby="lab-theme-label" className={styles.group}>
          {(['light', 'dark', 'system'] as const).map((value) => (
            <ToggleButton
              key={value}
              checked={mode === value}
              onClick={() => setMode(value)}
              size="small"
            >
              {THEME_LABELS[value]}
            </ToggleButton>
          ))}
        </div>
      </div>
      <Switch
        label="Reduce motion"
        checked={motion === 'reduce'}
        onChange={(_event, data) => setMotion(data.checked ? 'reduce' : 'system')}
      />
    </div>
  );
}

function ColourRoles() {
  const styles = useStyles();
  return (
    <div className={styles.swatchGrid}>
      {TONE_NAMES.map((tone) => {
        const t = cg.tone[tone];
        return (
          <div key={tone} className={styles.swatch}>
            <div className={styles.swatchCell} style={{ backgroundColor: t.tint, color: t.fg }}>
              {tone}: text on tint
            </div>
            <div
              className={styles.swatchCell}
              style={{ backgroundColor: t.solid, color: t.onSolid }}
            >
              {tone}: text on solid
            </div>
            <div
              className={styles.swatchCell}
              style={{
                backgroundColor: cg.surface,
                color: t.fg,
                boxShadow: `inset 0 0 0 2px ${t.border}`,
              }}
            >
              {tone}: text and border on surface
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PatternSwatches() {
  const prefix = `lab-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const kinds = ['hatch', 'dots', 'crosshatch'] as const;
  const tones = ['simulated', 'uncertain', 'unsupported'] as const;
  return (
    <svg
      width="600"
      height="76"
      viewBox="0 0 600 76"
      style={{ maxWidth: '100%', height: 'auto' }}
      role="img"
      aria-label="Pattern swatches: hatch for simulated, dots for uncertain, cross-hatch for unsupported; each tile is shown in all three tones."
    >
      <SvgPatternDefs idPrefix={prefix} tones={tones} kinds={kinds} />
      {kinds.map((kind, i) =>
        tones.map((tone, j) => (
          <g key={`${kind}-${tone}`}>
            <rect
              x={i * 200 + j * 62}
              y={8}
              width={56}
              height={40}
              rx={6}
              fill={patternUrl(prefix, kind, tone)}
              stroke={cg.tone[tone].border}
              strokeWidth={1.5}
            />
          </g>
        )),
      )}
      {kinds.map((kind, i) => (
        <text key={kind} x={i * 200} y={68} fontSize={12} fill={cg.textSecondary}>
          {kind}
        </text>
      ))}
    </svg>
  );
}

const CASE_COLUMNS: DataTableColumn<SampleCaseRow>[] = [
  {
    id: 'reference',
    header: 'Case',
    rowHeader: true,
    sortValue: (row) => row.reference,
    cell: (row) => row.reference,
  },
  { id: 'title', header: 'Title', sortValue: (row) => row.title, cell: (row) => row.title },
  {
    id: 'severity',
    header: 'Severity',
    sortValue: (row) => row.severity,
    cell: (row) => row.severity,
  },
  {
    id: 'quality',
    header: 'Quality index',
    align: 'end',
    sortValue: (row) => row.quality,
    cell: (row) =>
      row.quality === null
        ? 'Not available'
        : formatNumber(row.quality, { maximumFractionDigits: 0 }),
  },
  {
    id: 'warnings',
    header: 'Open warnings',
    align: 'end',
    sortValue: (row) => row.warnings,
    cell: (row) => row.warnings,
  },
];

function GraphSection() {
  const styles = useStyles();
  const [mode, setMode] = useState<GraphMode>('compare');
  const [selectedId, setSelectedId] = useState<string | null>('f1');
  const selected = SAMPLE_GRAPH.nodes.find((n) => n.id === selectedId) ?? null;
  return (
    <Section
      id="graph"
      title="Investigation Graph"
      description="About forty nodes: an actual path, a decision fork and a simulated branch from it. Use the arrow keys, Enter, Escape, plus, minus and 0."
    >
      <div className={styles.group} role="group" aria-label="Graph mode">
        {(['actual', 'counterfactual', 'compare'] as const).map((value) => (
          <ToggleButton
            key={value}
            checked={mode === value}
            onClick={() => setMode(value)}
            size="small"
          >
            {value === 'actual'
              ? 'Actual path'
              : value === 'counterfactual'
                ? 'Simulated path'
                : 'Compare both'}
          </ToggleButton>
        ))}
      </div>
      <div className={styles.graphWrap}>
        <InvestigationGraphView
          graph={SAMPLE_GRAPH}
          mode={mode}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
        <Panel
          title="Selected node"
          level={3}
          description="Rendered by the page, not by the graph."
        >
          {selected ? (
            <div className={styles.detail}>
              <KeyValueList
                columns={1}
                items={[
                  { id: 'label', label: 'Label', value: selected.label },
                  { id: 'kind', label: 'Kind', value: selected.kind },
                  { id: 'lane', label: 'Lane', value: selected.lane },
                  {
                    id: 'status',
                    label: 'Status',
                    value: <StatusBadge status={selected.status} />,
                  },
                  ...(selected.timestamp
                    ? [{ id: 'time', label: 'Time', value: formatDateTimeUtc(selected.timestamp) }]
                    : []),
                  ...(selected.simulated
                    ? [
                        {
                          id: 'sim',
                          label: 'Provenance',
                          value: <ProvenanceBadge kind="simulated" />,
                        },
                      ]
                    : []),
                ]}
              />
            </div>
          ) : (
            <p style={{ margin: 0, color: cg.textSecondary }}>
              Select a node to see its details here.
            </p>
          )}
        </Panel>
      </div>
    </Section>
  );
}

/**
 * Development-only gallery of every design-system component with static sample props. Use it to look at the system in
 * both themes, to screenshot it and to run axe against it. Nothing here comes from the API.
 */
export function DesignLab() {
  const styles = useStyles();
  const [asOf, setAsOf] = useState<string | null>(null);
  const [dialogResult, setDialogResult] = useState('No action taken yet.');
  const sections = [
    ['tokens', 'Tokens'],
    ['badges', 'Badges'],
    ['notices', 'Notices'],
    ['metrics', 'Metric cards'],
    ['states', 'States'],
    ['structure', 'Structure'],
    ['table', 'Table'],
    ['time', 'Time cursor'],
    ['dialogs', 'Dialogs'],
    ['charts', 'Charts'],
    ['graph', 'Graph'],
    ['path', 'Path comparison'],
    ['pairs', 'Light and dark side by side'],
  ] as const;

  return (
    <div className={styles.page}>
      <PageHeader
        title="Design lab"
        description="Every component with static sample values. Development only: this route does not exist in production builds."
        help="Open this page in light and dark, tab through it with the keyboard, and run an accessibility scan. The numbers are invented for visual checks; nothing here is product data."
        meta={<ProvenanceBadge kind="synthetic" label="Static sample values" />}
      />
      <Controls />
      <nav aria-label="Design lab sections">
        <ul className={styles.toc}>
          {sections.map(([id, label]) => (
            <li key={id}>
              <a className={styles.tocLink} href={`#${id}`}>
                {label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <Section
        id="tokens"
        title="Tokens"
        description="Colour roles: text on tint, text on solid, and text and border on the surface. Each pair is verified for contrast in both themes by a unit test."
      >
        <ColourRoles />
        <Specimen label="Pattern vocabulary (hatch: simulated, dots: uncertain, cross-hatch: unsupported)">
          <PatternSwatches />
        </Specimen>
        <Specimen label="Typography">
          <p
            className={styles.typeSample}
            style={{ fontSize: tokens.fontSizeHero800, fontWeight: tokens.fontWeightSemibold }}
          >
            Hero 800 · 72
          </p>
          <p
            className={styles.typeSample}
            style={{ fontSize: tokens.fontSizeBase500, fontWeight: tokens.fontWeightSemibold }}
          >
            Heading · Base 500
          </p>
          <p className={styles.typeSample} style={{ fontSize: tokens.fontSizeBase300 }}>
            Body text at 14 px is the minimum for reading content.
          </p>
          <p
            className={styles.typeSample}
            style={{ fontSize: tokens.fontSizeBase200, color: cg.textSecondary }}
          >
            Caption at 12 px is the minimum for secondary text.
          </p>
        </Specimen>
      </Section>

      <Section
        id="badges"
        title="Badges"
        description="Status is colour plus icon plus label plus pattern; provenance is a border style plus a label."
      >
        <div className={styles.row}>
          {BADGE_STATUSES.map((status) => (
            <StatusBadge key={status} status={status} />
          ))}
        </div>
        <div className={styles.row}>
          {BADGE_STATUSES.map((status) => (
            <StatusBadge key={status} status={status} size="small" />
          ))}
          <StatusBadge status="productive" iconOnly label="Productive (icon only)" />
        </div>
        <div className={styles.row}>
          <ProvenanceBadge kind="synthetic" />
          <ProvenanceBadge kind="estimated" />
          <ProvenanceBadge kind="simulated" />
          <ProvenanceBadge kind="simulated" size="medium" />
        </div>
      </Section>

      <Section id="notices" title="Notices">
        <div className={styles.grid2}>
          <Notice variant="info">Information that helps, without asking for action.</Notice>
          <Notice variant="warning">Something needs a look before continuing.</Notice>
          <Notice variant="synthetic">
            All case data in this environment is synthetic and for demonstration only.
          </Notice>
          <Notice variant="model-estimate">
            Confidence values are model estimates. They are not statistical truth.
          </Notice>
        </div>
      </Section>

      <Section
        id="metrics"
        title="Metric cards"
        description="Value, status, trend, estimated range, provenance, definition popover and an evidence link."
      >
        <div className={styles.grid}>
          {SAMPLE_METRICS.map((metric) => (
            <MetricCard key={metric.key} metric={metric} />
          ))}
        </div>
        <div className={styles.grid2}>
          <Specimen label="Range with a point estimate">
            <RangeBar value={72} low={66} high={78} label="Case Quality Index" />
          </Specimen>
          <Specimen label="Confidence band (always a model estimate)">
            <ConfidenceBand
              confidence={0.64}
              low={0.52}
              high={0.76}
              label="PAC file routes sign-in through the wrong proxy"
            />
          </Specimen>
        </div>
      </Section>

      <Section id="states" title="Loading, empty and error states">
        <div className={styles.grid2}>
          <LoadingSkeleton variant="card" label="Loading a card" />
          <LoadingSkeleton variant="list" count={3} label="Loading a list" />
          <LoadingSkeleton variant="table" count={3} label="Loading a table" />
          <LoadingSkeleton variant="chart" label="Loading a chart" />
        </div>
        <div className={styles.grid2}>
          <EmptyState
            title="No cases yet"
            description="Load the synthetic sample from Cases to see an analysed investigation."
            icon={<FolderRegular />}
            action={<Button appearance="primary">Open Cases</Button>}
          />
          <ErrorState
            title="The Command Center could not be loaded"
            description="The CaseGuard API could not be reached. Check that the API server is running, then retry."
            error={{
              status: 502,
              code: 'upstream_unavailable',
              correlationId: '3f9c1d52-7a4b-4c1e-9a55-2b7f6e0d8c11',
            }}
            onRetry={() => undefined}
          />
        </div>
      </Section>

      <Section id="structure" title="Panels, lists and help">
        <div className={styles.grid2}>
          <Panel
            title="Panel with help"
            description="A labelled group with a heading, help, actions and a footer."
            help="Panels give every card-like section the same spacing and heading."
            actions={<Button size="small">Action</Button>}
            footer={<a href="#structure">Footer link</a>}
          >
            <KeyValueList
              items={[
                { id: 'a', label: 'Product', value: 'Identity Gateway' },
                { id: 'b', label: 'Opened', value: formatDateTimeUtc('2025-03-03T08:02:00Z') },
                { id: 'c', label: 'Case id', value: 'case_01HZX3K9', mono: true },
                { id: 'd', label: 'Owner', value: 'Support team A', hint: 'Synthetic' },
              ]}
            />
          </Panel>
          <Panel title="Help and copy" level={2} accent="hypothesis">
            <div className={styles.row}>
              <HelpButton label="About this panel" title="About this panel">
                Contextual help opens in a popover and is keyboard operable.
              </HelpButton>
              <DefinitionPopover
                term="Case Quality Index"
                definition="A weighted composite of quality dimensions minus capped penalties."
                formula="CQI = sum(weight x dimension) - penalties"
                note="This is a model estimate shown with its range."
              />
              <CopyButton
                value="3f9c1d52-7a4b-4c1e-9a55-2b7f6e0d8c11"
                label="Copy correlation id"
                text="Copy id"
              />
              <Sparkline
                values={SAMPLE_CQI_HISTORY}
                label="Case Quality Index over the last 7 analyses"
                tone="brand"
              />
            </div>
          </Panel>
        </div>
      </Section>

      <Section
        id="table"
        title="Table"
        description="Sortable columns announce their sort order; the first column is the row header."
      >
        <DataTable
          caption="Sample cases"
          captionVisible
          columns={CASE_COLUMNS}
          rows={SAMPLE_CASE_ROWS}
          getRowId={(row) => row.id}
          defaultSort={{ columnId: 'reference', direction: 'ascending' }}
        />
      </Section>

      <Section
        id="time"
        title="Time cursor"
        description="Drag, use the arrow keys, or jump between events. It reports a boundary; it never shows anything from the future."
      >
        <TimeCursor
          min={SAMPLE_TIME_MIN}
          max={SAMPLE_TIME_MAX}
          value={asOf}
          onChange={setAsOf}
          markers={SAMPLE_TIME_MARKERS}
          withheldCount={asOf ? 3 : 0}
        />
        <p style={{ margin: 0, color: cg.textSecondary }}>
          <VisuallyHidden>Current boundary: </VisuallyHidden>
          {asOf ? `asOf = ${asOf}` : 'No boundary: everything up to the latest event is known.'}
        </p>
      </Section>

      <Section id="dialogs" title="Dialogs">
        <div className={styles.row}>
          <ConfirmDialog
            trigger={<Button>Open a confirmation</Button>}
            title="Publish this skill?"
            confirmLabel="Publish"
            onConfirm={() => setDialogResult('Published (sample).')}
          >
            Publishing makes the skill available to every engineer in the tenant. You can retire it
            later.
          </ConfirmDialog>
          <ConfirmDialog
            trigger={
              <Button appearance="outline" icon={<DeleteRegular />}>
                Open a destructive confirmation with a reason
              </Button>
            }
            title="Reject this counterfactual?"
            tone="danger"
            confirmLabel="Reject"
            reason={{ label: 'Reason for rejecting this path', minLength: 5 }}
            onConfirm={(reason) => setDialogResult(`Rejected (sample) with the reason: ${reason}`)}
          >
            The simulated path will be marked as rejected and excluded from skill extraction. The
            reason is recorded in the audit log.
          </ConfirmDialog>
        </div>
        <p role="status" style={{ margin: 0, color: cg.textSecondary }}>
          {dialogResult}
        </p>
      </Section>

      <Section
        id="charts"
        title="Charts"
        description="Each chart is an image with a text summary and a hidden data table; patterns carry meaning as well as colour."
      >
        <div className={styles.grid2}>
          <LineChart
            title="Hypothesis confidence over time"
            series={SAMPLE_LINE_SERIES}
            yDomain={[0, 1]}
            yFormat={(v) => `${Math.round(v * 100)}%`}
            events={SAMPLE_LINE_EVENTS}
            bandLabel="Estimated range"
          />
          <BarChart
            title="Where the avoidable effort comes from"
            data={SAMPLE_BARS}
            valueFormat={(v) => `${v}%`}
            valueLabel="Share of avoidable effort"
          />
          <BarChart
            title="Avoidable effort by component (vertical)"
            orientation="vertical"
            data={SAMPLE_BARS.slice(0, 4)}
            valueFormat={(v) => `${v}%`}
            valueLabel="Share"
            height={260}
          />
          <StackedBar
            title="Effort split for the case"
            segments={SAMPLE_STACKED}
            total={100}
            valueFormat={(v) => `${v}%`}
            valueLabel="Share of effort"
          />
        </div>
        <div className={styles.row}>
          <ScoreRing
            value={86}
            low={80}
            high={91}
            label="Evidence Integrity"
            status="good"
            caption="Estimated"
          />
          <ScoreRing
            value={72}
            low={66}
            high={78}
            label="Case Quality Index"
            status="watch"
            caption="Estimated"
          />
          <ScoreRing
            value={38}
            low={30}
            high={46}
            label="Reasoning Efficiency"
            status="poor"
            caption="Estimated"
          />
          <ScoreRing
            value={null}
            label="Resolution Confidence"
            status="unknown"
            caption="Not enough data"
          />
        </div>
        <div className={styles.grid2}>
          <DeltaBar
            label="Time to diagnosis"
            actual={9 * 1440}
            counterfactual={3 * 1440}
            counterfactualLow={2 * 1440}
            counterfactualHigh={4.5 * 1440}
            format={(n) => `${(n / 1440).toFixed(1)} days`}
          />
          <DeltaBar
            label="Resolution confidence"
            actual={54}
            counterfactual={71}
            counterfactualLow={60}
            counterfactualHigh={80}
            better="higher"
            format={(n) => `${n}%`}
          />
        </div>
      </Section>

      <GraphSection />

      <Section
        id="path"
        title="Path comparison"
        description="Solid connectors for what happened, dashed hatched connectors for the simulated alternative from the fork."
      >
        <PathComparison
          actual={SAMPLE_ACTUAL_TRACK}
          counterfactual={SAMPLE_SIMULATED_TRACK}
          forkStepId="f1"
          forkLabel="Reinstall chosen before checking the proxy"
          metrics={SAMPLE_PATH_METRICS}
        />
      </Section>

      <Section
        id="pairs"
        title="Light and dark side by side"
        description="The same components in both themes at once."
      >
        <ThemePair>
          <div className={styles.row}>
            <StatusBadge status="productive" />
            <StatusBadge status="uncertain" />
            <StatusBadge status="unsupported" />
            <StatusBadge status="missing" />
            <ProvenanceBadge kind="synthetic" />
            <ProvenanceBadge kind="estimated" />
            <ProvenanceBadge kind="simulated" />
          </div>
          <Notice variant="model-estimate" compact>
            Confidence values are model estimates.
          </Notice>
          <MetricCard metric={SAMPLE_CQI_METRIC} headingLevel={4} />
          <ConfidenceBand confidence={0.64} low={0.52} high={0.76} label="the leading hypothesis" />
        </ThemePair>
      </Section>
    </div>
  );
}
