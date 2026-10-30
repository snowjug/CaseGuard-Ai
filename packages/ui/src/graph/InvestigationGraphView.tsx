'use client';

import {
  Toolbar,
  ToolbarButton,
  ToolbarDivider,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import type { InvestigationGraph } from '@caseguard/schemas';
import {
  ArrowMaximizeRegular,
  ZoomFitRegular,
  ZoomInRegular,
  ZoomOutRegular,
  TargetRegular,
} from '@fluentui/react-icons';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { useElementSize } from '../hooks/useElementSize';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useSafeId } from '../hooks/useSafeId';
import { Notice } from '../primitives/Notice';
import { SvgPatternDefs } from '../primitives/SvgPatternDefs';
import { useReducedMotion } from '../theme/motion';
import { layout as layoutTokens } from '../tokens/static';
import { cg } from '../tokens/cg';
import { GraphLegend } from './GraphLegend';
import { GraphNodeView } from './GraphNodeView';
import { GraphTextAlternative } from './GraphTextAlternative';
import { resolveAlignment } from './alignment';
import { routeEdge } from './geometry';
import {
  divergenceFork,
  filterGraphByMode,
  findNeighbour,
  firstNodeId,
  layoutGraph,
  compareNodesForReading,
  SHAPE_CENTER_Y,
  type Direction,
  type GraphMode,
} from './layout';
import { KIND_META, edgeStyleOf } from './node-meta';
import {
  ZOOM_STEP,
  centerOn,
  fitTransform,
  initialTransform,
  revealRect,
  zoomAbout,
  type Transform,
} from './viewport';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: cg.space[3], minWidth: 0 },
  toolbar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: cg.space[2],
    padding: `${cg.space[1]} ${cg.space[2]}`,
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surface,
  },
  hint: { fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  zoom: {
    fontSize: tokens.fontSizeBase200,
    color: cg.textSecondary,
    fontVariantNumeric: 'tabular-nums',
    minWidth: '44px',
    textAlign: 'center',
  },
  viewport: {
    position: 'relative',
    overflow: 'hidden',
    borderRadius: cg.radius.lg,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surface,
    touchAction: 'none',
  },
  svg: { display: 'block', width: '100%', height: '100%', cursor: 'grab' },
  panning: { cursor: 'grabbing' },
});

export interface InvestigationGraphViewProps {
  /** The graph from `graph.get`. The component never invents nodes or edges. */
  graph: InvestigationGraph;
  /** Selected node id (controlled). The page renders the side panel for it. */
  selectedId?: string | null;
  /** Called with a node id on Enter/Space/click, and with `null` on Escape or background click. */
  onSelect?: (id: string | null) => void;
  /**
   * `actual`: the real path only. `counterfactual`: shared history up to the fork plus the simulated route.
   * `compare`: both, with the divergence at the fork highlighted.
   */
  mode?: GraphMode;
  /**
   * How columns line up across lanes. `auto` (default) uses timestamps when every lane numbers its own nodes from 0 and
   * the actual path is timed (the shape of a `graph.get` response), so a simulated path starts under the fork it
   * branches from; otherwise it uses `order`. `order` / `time` force one of them.
   */
  alignment?: 'auto' | 'order' | 'time';
  className?: string;
  /** Canvas height in px (default 560). */
  height?: number;
  /** Always show the accessible list instead of the canvas (it is also used below 640 px). */
  forceList?: boolean;
  /** The page's details for the selected node; shown right under the canvas (or the list) so it stays next to it. */
  detail?: ReactNode;
}

const LABEL = 'cg-graph';

/**
 * Interactive investigation graph (SVG). Lane layout with no overlapping nodes, zoom/pan/fit/focus controls,
 * roving-tabindex keyboard navigation (arrows move to the nearest neighbour, Enter selects, Esc clears, + - 0 zoom and
 * fit), solid actual edges versus dashed hatched simulated edges, a legend, and a text alternative.
 */
export function InvestigationGraphView({
  graph,
  selectedId = null,
  onSelect,
  mode = 'compare',
  alignment = 'auto',
  className,
  height = 560,
  forceList = false,
  detail,
}: InvestigationGraphViewProps) {
  const styles = useStyles();
  const idPrefix = useSafeId(LABEL);
  const reduceMotion = useReducedMotion();
  const isMobile = useMediaQuery(`(max-width: ${layoutTokens.mobileBreakpoint - 1}px)`, false);
  const [viewportRef, view] = useElementSize<HTMLDivElement>({ width: 960, height });

  const visible = useMemo(() => filterGraphByMode(graph, mode), [graph, mode]);
  const hasFork = visible.nodes.some((n) => n.kind === 'fork');
  // Detected on the whole graph: a mode filter can remove the nodes that make the numbering recognisable.
  const columnAlignment = useMemo(
    () => resolveAlignment(graph.nodes, alignment),
    [graph.nodes, alignment],
  );
  const layout = useMemo(
    () =>
      layoutGraph(visible, {
        headerHeight: mode === 'compare' && hasFork ? 34 : 0,
        alignment: columnAlignment,
      }),
    [visible, mode, hasFork, columnAlignment],
  );
  const fork = useMemo(() => divergenceFork(layout), [layout]);

  const layoutKey = `${mode}:${graph.caseId}:${graph.scenarioId ?? ''}:${layout.nodes.length}:${layout.edges.length}`;
  const [manual, setManual] = useState<{ key: string; transform: Transform } | null>(null);
  const [activeState, setActiveState] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);

  const content = { width: layout.width, height: layout.height };
  const focusNodeForStart = fork ?? layout.nodeById.get(firstNodeId(layout) ?? '') ?? null;
  const base = initialTransform(
    content,
    view,
    focusNodeForStart ? { x: focusNodeForStart.cx, y: focusNodeForStart.cy } : null,
  );
  const transform = manual && manual.key === layoutKey ? manual.transform : base;

  const activeId =
    activeState && layout.nodeById.has(activeState)
      ? activeState
      : selectedId && layout.nodeById.has(selectedId)
        ? selectedId
        : firstNodeId(layout);

  const nodeRefs = useRef(new Map<string, SVGGElement>());
  const registerNode = (id: string, element: SVGGElement | null): void => {
    if (element) nodeRefs.current.set(id, element);
    else nodeRefs.current.delete(id);
  };

  const apply = (next: Transform): void => setManual({ key: layoutKey, transform: next });
  const zoom = (factor: number): void =>
    apply(zoomAbout(transform, factor, view.width / 2, view.height / 2));
  const fit = (): void => apply(fitTransform(content, view));
  const focusSelection = (): void => {
    const target = layout.nodeById.get(selectedId ?? activeId ?? '');
    if (target) apply(centerOn(target.cx, target.cy, Math.max(transform.k, 1), view));
  };

  const focusNode = (id: string): void => {
    const target = layout.nodeById.get(id);
    if (!target) return;
    setActiveState(id);
    nodeRefs.current.get(id)?.focus({ preventScroll: true });
    const next = revealRect(transform, target, view);
    if (next !== transform) apply(next);
  };

  const onNodeKeyDown = (event: KeyboardEvent<SVGGElement>, id: string): void => {
    const directions: Record<string, Direction> = {
      ArrowLeft: 'left',
      ArrowRight: 'right',
      ArrowUp: 'up',
      ArrowDown: 'down',
    };
    const direction = directions[event.key];
    if (direction) {
      event.preventDefault();
      const next = findNeighbour(layout, id, direction);
      if (next) focusNode(next);
      return;
    }
    switch (event.key) {
      case 'Enter':
      case ' ':
        event.preventDefault();
        onSelect?.(id);
        return;
      case 'Escape':
        event.preventDefault();
        onSelect?.(null);
        return;
      case '+':
      case '=':
        event.preventDefault();
        zoom(ZOOM_STEP);
        return;
      case '-':
      case '_':
        event.preventDefault();
        zoom(1 / ZOOM_STEP);
        return;
      case '0':
        event.preventDefault();
        fit();
        return;
      case 'Home':
      case 'End': {
        event.preventDefault();
        const ordered = [...layout.nodes].sort((a, b) => compareNodesForReading(a.node, b.node));
        const target = event.key === 'Home' ? ordered[0] : ordered[ordered.length - 1];
        if (target) focusNode(target.id);
        return;
      }
      default:
    }
  };

  // Ctrl/Cmd + wheel (and trackpad pinch) zooms about the pointer; a plain wheel keeps scrolling the page.
  const svgRef = useRef<SVGSVGElement | null>(null);
  const transformRef = useRef(transform);
  useEffect(() => {
    transformRef.current = transform;
  });
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const bounds = svg.getBoundingClientRect();
      const next = zoomAbout(
        transformRef.current,
        event.deltaY < 0 ? 1.12 : 1 / 1.12,
        event.clientX - bounds.left,
        event.clientY - bounds.top,
      );
      setManual({ key: layoutKey, transform: next });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [layoutKey, isMobile, forceList]);

  const drag = useRef<{ x: number; y: number; start: Transform; moved: boolean } | null>(null);
  const onPointerDown = (event: PointerEvent<SVGRectElement>): void => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, start: transform, moved: false };
    setPanning(true);
  };
  const onPointerMove = (event: PointerEvent<SVGRectElement>): void => {
    const state = drag.current;
    if (!state) return;
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    if (!state.moved && Math.hypot(dx, dy) < 4) return;
    state.moved = true;
    apply({ k: state.start.k, tx: state.start.tx + dx, ty: state.start.ty + dy });
  };
  const onPointerUp = (event: PointerEvent<SVGRectElement>): void => {
    const state = drag.current;
    drag.current = null;
    setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (state && !state.moved) onSelect?.(null);
  };

  const routes = useMemo(
    () =>
      layout.edges.flatMap((edge) => {
        const from = layout.nodeById.get(edge.from);
        const to = layout.nodeById.get(edge.to);
        if (!from || !to) return [];
        return [{ edge, route: routeEdge(from, to, (n) => KIND_META[n.kind].shape) }];
      }),
    [layout],
  );

  const showList = forceList || isMobile;
  const summaryText = `Investigation graph with ${graph.nodes.length} nodes and ${graph.edges.length} connections. Tab to enter the graph, arrow keys move to the nearest node, Enter selects, Escape clears, plus and minus zoom, 0 fits the whole graph.`;

  const textAlternative = (
    <GraphTextAlternative
      nodes={graph.nodes}
      edges={graph.edges}
      summary={graph.summary}
      selectedId={selectedId}
      {...(onSelect ? { onSelect } : {})}
      asList={showList}
      defaultOpen={showList}
    />
  );

  if (graph.nodes.length === 0) {
    return (
      <div className={mergeClasses(styles.root, className)}>
        <Notice variant="info" title="No graph yet">
          The investigation graph has no nodes for this case yet. Run the analysis to build it.
        </Notice>
        {textAlternative}
      </div>
    );
  }

  if (showList) {
    return (
      <div className={mergeClasses(styles.root, className)}>
        <Notice variant="info" title="List view" compact>
          The interactive canvas is available on wider screens. This list contains every node and
          connection.
        </Notice>
        {detail}
        {textAlternative}
      </div>
    );
  }

  const markerTones = ['actual', 'simulated', 'evidence', 'skill', 'neutral', 'fork'] as const;
  const zoomPercent = `${Math.round(transform.k * 100)}%`;

  return (
    <div className={mergeClasses(styles.root, className)}>
      <div className={styles.toolbar}>
        <Toolbar aria-label="Graph controls" size="small">
          <ToolbarButton
            icon={<ZoomOutRegular />}
            aria-label="Zoom out"
            title="Zoom out (−)"
            onClick={() => zoom(1 / ZOOM_STEP)}
          />
          <span className={styles.zoom} aria-live="polite" aria-label={`Zoom ${zoomPercent}`}>
            {zoomPercent}
          </span>
          <ToolbarButton
            icon={<ZoomInRegular />}
            aria-label="Zoom in"
            title="Zoom in (+)"
            onClick={() => zoom(ZOOM_STEP)}
          />
          <ToolbarDivider />
          <ToolbarButton
            icon={<ZoomFitRegular />}
            aria-label="Fit whole graph"
            title="Fit whole graph (0)"
            onClick={fit}
          />
          <ToolbarButton
            icon={<TargetRegular />}
            aria-label="Focus the selected node"
            title="Focus the selected node"
            onClick={focusSelection}
          />
          <ToolbarButton
            icon={<ArrowMaximizeRegular />}
            aria-label="Reset view"
            title="Reset view"
            onClick={() => setManual(null)}
          />
        </Toolbar>
        <span className={styles.hint}>
          Arrow keys move between nodes · Enter selects · Esc clears · Ctrl + scroll zooms
        </span>
      </div>

      {layout.truncated || graph.truncated ? (
        <Notice variant="warning" title="Large graph" compact>
          {layout.truncated
            ? `Showing the first ${layout.nodes.length} of ${layout.nodes.length + layout.omittedNodeCount} nodes. `
            : `The API limited this graph to ${graph.nodeLimit} nodes. `}
          The text alternative below lists everything that was returned.
        </Notice>
      ) : null}

      <div ref={viewportRef} className={styles.viewport} style={{ height }}>
        <svg
          ref={svgRef}
          role="group"
          aria-label={summaryText}
          className={mergeClasses(styles.svg, panning && styles.panning)}
          viewBox={`0 0 ${view.width} ${view.height}`}
        >
          <defs>
            {markerTones.map((tone) => (
              <marker
                key={tone}
                id={`${idPrefix}-arrow-${tone}`}
                viewBox="0 0 12 12"
                refX="10"
                refY="6"
                markerWidth="12"
                markerHeight="12"
                markerUnits="userSpaceOnUse"
                orient="auto"
              >
                <path d="M1 1.5L11 6L1 10.5Z" fill={cg.tone[tone].solid} />
              </marker>
            ))}
            <marker
              id={`${idPrefix}-bar`}
              viewBox="0 0 12 12"
              refX="6"
              refY="6"
              markerWidth="12"
              markerHeight="12"
              markerUnits="userSpaceOnUse"
              orient="auto"
            >
              <path d="M6 0.5V11.5" stroke={cg.tone.unsupported.solid} strokeWidth="2.5" />
            </marker>
          </defs>
          <SvgPatternDefs
            idPrefix={idPrefix}
            tones={['simulated', 'unsupported', 'uncertain']}
            kinds={['hatch', 'crosshatch', 'dots']}
          />
          <rect
            width={view.width}
            height={view.height}
            fill="transparent"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            role="presentation"
          />
          <g
            style={{
              transform: `translate(${transform.tx}px, ${transform.ty}px) scale(${transform.k})`,
              transformOrigin: '0 0',
              transition:
                reduceMotion || panning
                  ? 'none'
                  : `transform ${cg.motion.base} ${cg.motion.easing}`,
            }}
          >
            <g aria-hidden="true">
              {layout.lanes.map((lane) => (
                <g key={lane.id}>
                  <rect
                    x={layout.options.padding}
                    y={lane.y - 6}
                    width={layout.width - layout.options.padding * 2}
                    height={lane.height + 8}
                    rx={10}
                    fill="none"
                    stroke={cg.borderSubtle}
                  />
                  <text
                    x={layout.options.padding + 12}
                    y={lane.y + SHAPE_CENTER_Y}
                    dominantBaseline="middle"
                    fill={cg.textSecondary}
                    fontSize={12}
                    fontWeight={600}
                  >
                    {lane.label}
                  </text>
                </g>
              ))}
              {mode === 'compare' && fork ? (
                <g>
                  <line
                    x1={fork.cx}
                    x2={fork.cx}
                    y1={layout.options.padding + 30}
                    y2={layout.height - layout.options.padding}
                    stroke={cg.tone.fork.solid}
                    strokeWidth={1.5}
                    strokeDasharray="2 5"
                    strokeLinecap="round"
                  />
                  <rect
                    x={Math.max(
                      layout.options.padding,
                      Math.min(fork.cx - 92, layout.width - layout.options.padding - 184),
                    )}
                    y={layout.options.padding - 4}
                    width={184}
                    height={26}
                    rx={13}
                    fill={cg.tone.fork.tint}
                    stroke={cg.tone.fork.solid}
                    strokeWidth={1.5}
                  />
                  <text
                    x={
                      Math.max(
                        layout.options.padding,
                        Math.min(fork.cx - 92, layout.width - layout.options.padding - 184),
                      ) + 92
                    }
                    y={layout.options.padding + 9}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill={cg.tone.fork.fg}
                    fontSize={12}
                    fontWeight={600}
                  >
                    Paths diverge at this fork
                  </text>
                </g>
              ) : null}
              {routes.map(({ edge, route }) => {
                const style = edgeStyleOf(edge.edge);
                const color = cg.tone[style.tone].solid;
                const incident = selectedId
                  ? edge.from === selectedId || edge.to === selectedId
                  : false;
                const faded = selectedId !== null && !incident;
                const marker =
                  style.cap === 'bar'
                    ? `url(#${idPrefix}-bar)`
                    : `url(#${idPrefix}-arrow-${(markerTones as readonly string[]).includes(style.tone) ? style.tone : 'neutral'})`;
                const emphasis =
                  mode === 'compare' && (style.simulated || edge.edge.kind === 'actual') ? 1.15 : 1;
                return (
                  <g
                    key={edge.id}
                    opacity={faded ? 0.3 : 1}
                    data-edge-kind={edge.edge.kind}
                    data-simulated={style.simulated ? 'true' : 'false'}
                  >
                    {style.simulated ? (
                      <path
                        d={route.d}
                        fill="none"
                        stroke={`url(#${idPrefix}-pat-hatch-simulated)`}
                        strokeWidth={8}
                        strokeDasharray={style.dash}
                        strokeLinecap="butt"
                      />
                    ) : null}
                    <path
                      d={route.d}
                      fill="none"
                      stroke={color}
                      strokeWidth={(incident ? style.width + 1 : style.width) * emphasis}
                      strokeDasharray={style.dash}
                      strokeLinecap="round"
                      markerEnd={marker}
                    />
                  </g>
                );
              })}
            </g>
            <g>
              {layout.nodes.map((item) => (
                <GraphNodeView
                  key={item.id}
                  item={item}
                  idPrefix={idPrefix}
                  selected={item.id === selectedId}
                  tabbable={item.id === activeId}
                  dimmed={false}
                  onSelect={(id) => onSelect?.(id)}
                  onKeyDown={onNodeKeyDown}
                  onFocus={setActiveState}
                  registerNode={registerNode}
                />
              ))}
            </g>
          </g>
        </svg>
      </div>

      {detail}
      <GraphLegend idPrefix={`${idPrefix}-legend`} />
      {textAlternative}
    </div>
  );
}
