import {
  CircleCheckIcon,
  CircleHelpIcon,
  CircleXIcon,
  InfoIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from 'lucide-react';
import type { ToneName } from '../tokens/palette';
import type { PatternKind } from './patterns';

/** Quality status shared by graph nodes (`GraphNode.status`) and badges. */
export type BadgeStatus = 'productive' | 'uncertain' | 'unsupported' | 'missing' | 'neutral';

export interface StatusMeta {
  label: string;
  tone: ToneName;
  icon: LucideIcon;
  /** Texture used where several statuses share a chart or the graph; badges rely on icon and word instead. */
  pattern: PatternKind;
  /** One-line meaning, used by legends and screen-reader text. */
  description: string;
}

/** Grammar of every status: colour plus icon plus word (and a texture in charts), so colour is never alone. */
export const STATUS_META: Record<BadgeStatus, StatusMeta> = {
  productive: {
    label: 'Productive',
    tone: 'productive',
    icon: CircleCheckIcon,
    pattern: 'solid',
    description: 'Advanced the investigation with supporting evidence',
  },
  uncertain: {
    label: 'Uncertain',
    tone: 'uncertain',
    icon: TriangleAlertIcon,
    pattern: 'dots',
    description: 'Outcome or support is not yet established',
  },
  unsupported: {
    label: 'Unsupported',
    tone: 'unsupported',
    icon: CircleXIcon,
    pattern: 'crosshatch',
    description: 'Not supported by the available evidence',
  },
  missing: {
    label: 'Missing',
    tone: 'missing',
    icon: CircleHelpIcon,
    pattern: 'outline',
    description: 'Expected evidence has not been collected',
  },
  neutral: {
    label: 'Neutral',
    tone: 'neutral',
    icon: InfoIcon,
    pattern: 'solid',
    description: 'No quality judgement attached',
  },
};

export const BADGE_STATUSES = Object.keys(STATUS_META) as BadgeStatus[];
