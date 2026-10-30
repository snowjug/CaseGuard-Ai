import type { GraphEdge, GraphNode } from '@caseguard/schemas';
import {
  AlertUrgentRegular,
  BeakerRegular,
  BranchForkRegular,
  DocumentSearchRegular,
  FlagRegular,
  FlashRegular,
  LightbulbRegular,
  PlayRegular,
  type FluentIcon,
} from '@fluentui/react-icons';
import { formatProbability } from '../format';
import { STATUS_META } from '../primitives/status-meta';
import type { ToneName } from '../tokens/palette';
import type { NodeShape } from './geometry';

export type GraphNodeKind = GraphNode['kind'];
export type GraphEdgeKind = GraphEdge['kind'];

export interface KindMeta {
  label: string;
  shape: NodeShape;
  tone: ToneName;
  icon: FluentIcon;
  /** `solid`: filled with the tone; `tint`: light fill with a tone outline; `hatch`: simulated texture. */
  fill: 'solid' | 'tint' | 'hatch';
  description: string;
}

/** UI_SPEC section 1: shape, colour role and icon per node kind. */
export const KIND_META: Record<GraphNodeKind, KindMeta> = {
  problem: {
    label: 'Problem',
    shape: 'stadium',
    tone: 'actual',
    icon: AlertUrgentRegular,
    fill: 'solid',
    description: 'The initial problem statement',
  },
  evidence: {
    label: 'Evidence',
    shape: 'circle',
    tone: 'evidence',
    icon: DocumentSearchRegular,
    fill: 'solid',
    description: 'Information available in the case',
  },
  hypothesis: {
    label: 'Hypothesis',
    shape: 'hexagon',
    tone: 'hypothesis',
    icon: LightbulbRegular,
    fill: 'tint',
    description: 'A candidate explanation with model-estimated confidence',
  },
  action: {
    label: 'Action',
    shape: 'square',
    tone: 'actual',
    icon: PlayRegular,
    fill: 'solid',
    description: 'An action that was actually taken',
  },
  fork: {
    label: 'Decision fork',
    shape: 'diamond',
    tone: 'fork',
    icon: BranchForkRegular,
    fill: 'solid',
    description: 'A point where a better path was available',
  },
  outcome: {
    label: 'Outcome',
    shape: 'stadium',
    tone: 'actual',
    icon: FlagRegular,
    fill: 'tint',
    description: 'A result of the investigation',
  },
  counterfactual_step: {
    label: 'Simulated step',
    shape: 'square',
    tone: 'simulated',
    icon: BeakerRegular,
    fill: 'hatch',
    description: 'A step of the simulated alternative path',
  },
  skill: {
    label: 'SkillDNA',
    shape: 'dna',
    tone: 'skill',
    icon: FlashRegular,
    fill: 'tint',
    description: 'Reusable skill extracted from the validated path',
  },
};

export const GRAPH_NODE_KINDS = Object.keys(KIND_META) as GraphNodeKind[];

export interface EdgeStyle {
  label: string;
  tone: ToneName;
  width: number;
  dash: string | undefined;
  /** Simulated edges are dashed, hatched and labelled "Simulated". */
  simulated: boolean;
  /** `bar` caps a contradiction; everything else uses an arrow. */
  cap: 'arrow' | 'bar';
}

/**
 * Solid for actual edges, dashed + hatch for simulated ones; relationship edges are thinner. An edge is simulated when
 * the API says so or when it is a `counterfactual` edge. A `branches` edge is simulated only when flagged: the API also
 * uses it, unflagged, for the real "decision point" link from an action to its fork, which must not read as a simulation.
 */
export function edgeStyleOf(edge: Pick<GraphEdge, 'kind' | 'simulated'>): EdgeStyle {
  const simulated = edge.simulated || edge.kind === 'counterfactual';
  if (simulated) {
    return {
      label: 'Simulated path',
      tone: 'simulated',
      width: 2.5,
      dash: '8 5',
      simulated: true,
      cap: 'arrow',
    };
  }
  switch (edge.kind) {
    case 'actual':
      return {
        label: 'Actual path',
        tone: 'actual',
        width: 2.75,
        dash: undefined,
        simulated: false,
        cap: 'arrow',
      };
    case 'supports':
      return {
        label: 'Supports',
        tone: 'evidence',
        width: 1.5,
        dash: undefined,
        simulated: false,
        cap: 'arrow',
      };
    case 'contradicts':
      return {
        label: 'Contradicts',
        tone: 'unsupported',
        width: 1.75,
        dash: undefined,
        simulated: false,
        cap: 'bar',
      };
    case 'extracts':
      return {
        label: 'Extracts',
        tone: 'skill',
        width: 2,
        dash: undefined,
        simulated: false,
        cap: 'arrow',
      };
    case 'branches':
      return {
        label: 'Branch point',
        tone: 'fork',
        width: 2,
        dash: undefined,
        simulated: false,
        cap: 'arrow',
      };
    default:
      return {
        label: 'Informs',
        tone: 'neutral',
        width: 1.25,
        dash: undefined,
        simulated: false,
        cap: 'arrow',
      };
  }
}

/** One-sentence accessible name for a node: kind, label, status, simulated flag, confidence, then the API's text. */
export function nodeAriaLabel(node: GraphNode): string {
  const parts = [`${KIND_META[node.kind].label}: ${node.label}`, STATUS_META[node.status].label];
  if (node.simulated) parts.push('Simulated, not something that happened');
  if (node.confidence !== null)
    parts.push(`Confidence ${formatProbability(node.confidence)}, a model estimate`);
  if (node.textAlternative) parts.push(node.textAlternative);
  return parts.join('. ');
}
