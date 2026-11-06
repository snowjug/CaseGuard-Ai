'use client';

import type { CounterfactualScenario, DecisionFork, GraphNode } from '@caseguard/schemas';
import {
  Button,
  IconButton,
  InvestigationGraphView,
  KIND_META,
  LoadingSkeleton,
  Notice,
  Panel,
  ProvenanceBadge,
  SegmentedControl,
  StatusBadge,
  UiLink,
  cg,
  formatDateTimeUtc,
  formatProbability,
  type GraphMode,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { XIcon } from 'lucide-react';
import { useMemo } from 'react';
import { AsOfLimited, LaterDecisionsNote, isRateLimited } from '../../components/case/as-of';
import { QueryErrorState } from '../../components/common/QueryErrorState';
import { caseHref, evidenceLinkHref, EVIDENCE_LINK_TYPE_LABELS } from '../../lib/deep-links';
import { codecs, useSelectionState, useUrlState } from '../../lib/url-state';
import { TruncatedText } from '../reasoning/TruncatedText';
import { useGraphQuery } from './hooks';

const MODES = ['compare', 'actual', 'counterfactual'] as const;
const MODE_CODEC = codecs.enumOf(MODES, 'compare');

const MODE_TEXT: Record<GraphMode, { label: string; note: string }> = {
  compare: {
    label: 'Compare both paths',
    note: 'The whole record with the simulated path branching from its key decision. It includes what happened after the decision, which the simulation did not know.',
  },
  actual: {
    label: 'Recorded path only',
    note: 'What actually happened, with no simulation.',
  },
  counterfactual: {
    label: 'Decision-time view',
    note: 'Only what was known at the decision moment, plus the simulated path. The recorded path stops at the key decision and nothing later is requested.',
  },
};

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[3], minWidth: 0 },
  side: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    padding: cg.space[3],
    borderRadius: cg.radius.lg,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surface,
    minWidth: 0,
  },
  sideHead: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: cg.space[2],
  },
  h3: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
    overflowWrap: 'anywhere',
  },
  h4: { margin: 0, fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold },
  text: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
    overflowWrap: 'anywhere',
  },
  muted: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  badges: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  links: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  link: {
    color: cg.textLink,
    textDecorationLine: 'underline',
    textUnderlineOffset: '2px',
    minHeight: '24px',
    display: 'inline-flex',
    alignItems: 'center',
  },
  radios: { display: 'flex', flexWrap: 'wrap', gap: cg.space[2] },
});

export interface GraphPanelProps {
  caseId: string;
  fork: DecisionFork;
  scenario: CounterfactualScenario | null;
  /** Show the selected fork's scenario in the lab. */
  onOpenFork: (forkId: string) => void;
  /** Open one simulated step in the evidence inspector. */
  onOpenStep: (stepId: string) => void;
  onOpenScenario: (scenarioId: string) => void;
}

interface Ref {
  type: GraphNode['refs'][number]['type'];
  id: string;
}

function NodeDetails({
  caseId,
  node,
  onClose,
  onOpenFork,
  onOpenStep,
  onOpenScenario,
}: { caseId: string; node: GraphNode; onClose: () => void } & Pick<
  GraphPanelProps,
  'onOpenFork' | 'onOpenStep' | 'onOpenScenario'
>) {
  const styles = useStyles();
  const kind = KIND_META[node.kind];
  const refs = node.refs.filter(
    (ref, index, all) =>
      ref.type !== 'action' &&
      all.findIndex((other) => other.type === ref.type && other.id === ref.id) === index,
  );

  const renderRef = (ref: Ref) => {
    const label = `${EVIDENCE_LINK_TYPE_LABELS[ref.type as keyof typeof EVIDENCE_LINK_TYPE_LABELS] ?? ref.type} ${ref.id}`;
    switch (ref.type) {
      case 'fork':
        return (
          <Button size="sm" variant="secondary" onClick={() => onOpenFork(ref.id)}>
            Open this key decision
          </Button>
        );
      case 'scenario':
        return (
          <Button size="sm" variant="secondary" onClick={() => onOpenScenario(ref.id)}>
            Open this simulated path
          </Button>
        );
      case 'step':
        return (
          <Button size="sm" variant="secondary" onClick={() => onOpenStep(ref.id)}>
            Inspect this simulated step
          </Button>
        );
      case 'skill':
        return (
          <UiLink className={styles.link} href={`/skills/${encodeURIComponent(ref.id)}`}>
            Open the skill
          </UiLink>
        );
      case 'hypothesis':
        return (
          <UiLink
            className={styles.link}
            href={`${caseHref(caseId, 'hypotheses')}?sel=${encodeURIComponent(ref.id)}`}
          >
            {label}
          </UiLink>
        );
      case 'action':
        return null;
      case 'event':
      case 'evidence':
      case 'claim':
      case 'requirement':
        return (
          <UiLink
            className={styles.link}
            href={evidenceLinkHref(caseId, { type: ref.type, id: ref.id })}
          >
            {label}
          </UiLink>
        );
      default:
        return null;
    }
  };

  return (
    <section className={styles.side} aria-label={`Details of ${node.label}`}>
      <div className={styles.sideHead}>
        <div>
          <p className={styles.muted}>{kind.label}</p>
          <h3 className={styles.h3}>{node.label}</h3>
        </div>
        <IconButton size="sm" icon={<XIcon />} label="Close the node details" onClick={onClose} />
      </div>
      <div className={styles.badges}>
        <StatusBadge status={node.status} size="small" />
        {node.simulated ? <ProvenanceBadge kind="simulated" /> : null}
        {node.confidence !== null ? (
          <ProvenanceBadge
            kind="estimated"
            label={`${formatProbability(node.confidence)} estimate`}
          />
        ) : null}
      </div>
      {node.timestamp ? <p className={styles.muted}>{formatDateTimeUtc(node.timestamp)}</p> : null}
      <p className={styles.text}>
        <TruncatedText text={node.detail} limit={280} />
      </p>
      {refs.length > 0 ? (
        <section aria-label="Source links">
          <h4 className={styles.h4}>Source links</h4>
          <ul className={styles.links}>
            {refs.map((ref) => {
              const content = renderRef(ref);
              return content ? <li key={`${ref.type}:${ref.id}`}>{content}</li> : null;
            })}
          </ul>
        </section>
      ) : null}
      <p className={styles.muted}>{node.textAlternative}</p>
    </section>
  );
}

/**
 * The shared Investigation Graph driven by the real `graph.get`: the recorded path, the simulated path and where they
 * diverge, in three views. Selecting a node opens its details with links to the evidence behind it; the graph also has
 * a table alternative. Only the visible view is requested; the decision-time view asks for nothing later than the fork.
 */
export function GraphPanel({
  caseId,
  fork,
  scenario,
  onOpenFork,
  onOpenStep,
  onOpenScenario,
}: GraphPanelProps) {
  const styles = useStyles();
  const [mode, setMode] = useUrlState('mode', MODE_CODEC);
  const [selected, select] = useSelectionState('node');
  const effectiveMode: GraphMode = scenario || mode === 'actual' ? mode : 'actual';
  const query = useGraphQuery(caseId, {
    scenarioId: effectiveMode === 'actual' ? null : (scenario?.id ?? null),
    asOf: effectiveMode === 'counterfactual' ? (scenario?.boundary.asOf ?? null) : null,
    enabled: true,
  });
  const node = useMemo(
    () => query.data?.nodes.find((n) => n.id === selected) ?? null,
    [query.data, selected],
  );

  return (
    <Panel
      title="Investigation graph"
      level={3}
      description="The problem, the evidence, the possible causes, what was done and where the simulated path diverges."
      help="Solid connectors are what happened. Dashed, hatched connectors and nodes are simulated and always labelled. Use the arrow keys to move between nodes, Enter to select and Escape to clear. The table below the canvas lists every node and connection."
      accent="simulated"
    >
      <div className={styles.stack}>
        <SegmentedControl
          aria-label="Graph view"
          value={effectiveMode}
          onValueChange={(value) => setMode(value)}
          options={MODES.map((value) => ({
            value,
            label: MODE_TEXT[value].label,
            disabled: value !== 'actual' && !scenario,
          }))}
        />
        <p className={styles.muted}>{MODE_TEXT[effectiveMode].note}</p>
        {effectiveMode === 'counterfactual' ? <LaterDecisionsNote /> : null}
        {!scenario ? (
          <Notice variant="info" compact title="Recorded path only">
            Generate a simulated path for this key decision to compare the two paths in the graph.
          </Notice>
        ) : null}
        {query.isPending ? (
          <LoadingSkeleton variant="graph" count={1} label="Loading the investigation graph" />
        ) : query.isError ? (
          effectiveMode === 'counterfactual' && isRateLimited(query.error) ? (
            <AsOfLimited
              key={query.errorUpdatedAt}
              error={query.error}
              subject="the decision-time graph"
              onRetry={() => void query.refetch()}
              retrying={query.isFetching}
              onWholeRecord={() => setMode('compare')}
            />
          ) : (
            <QueryErrorState
              compact
              subject="The investigation graph"
              error={query.error}
              onRetry={() => void query.refetch()}
              retrying={query.isFetching}
            />
          )
        ) : (
          <InvestigationGraphView
            graph={query.data}
            mode={effectiveMode}
            selectedId={selected}
            onSelect={select}
            height={480}
            detail={
              node ? (
                <NodeDetails
                  caseId={caseId}
                  node={node}
                  onClose={() => select(null)}
                  onOpenFork={onOpenFork}
                  onOpenStep={onOpenStep}
                  onOpenScenario={onOpenScenario}
                />
              ) : null
            }
          />
        )}
        <p className={styles.muted}>
          Paths diverge at: {fork.title} ({formatDateTimeUtc(fork.timestamp)}).
        </p>
      </div>
    </Panel>
  );
}
