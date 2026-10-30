import {
  CheckmarkCircleRegular,
  DismissCircleRegular,
  InfoRegular,
  QuestionCircleRegular,
  WarningRegular,
  type FluentIcon,
} from '@fluentui/react-icons';
import type { ToneName } from '../tokens/palette';
import type { PatternKind } from './patterns';

/** Quality status shared by graph nodes (`GraphNode.status`) and badges. */
export type BadgeStatus = 'productive' | 'uncertain' | 'unsupported' | 'missing' | 'neutral';

export interface StatusMeta {
  label: string;
  tone: ToneName;
  icon: FluentIcon;
  pattern: PatternKind;
  /** One-line meaning, used by legends and screen-reader text. */
  description: string;
}

/** Grammar from UI_SPEC section 1: colour + icon + label + pattern for every status. */
export const STATUS_META: Record<BadgeStatus, StatusMeta> = {
  productive: {
    label: 'Productive',
    tone: 'productive',
    icon: CheckmarkCircleRegular,
    pattern: 'solid',
    description: 'Advanced the investigation with supporting evidence',
  },
  uncertain: {
    label: 'Uncertain',
    tone: 'uncertain',
    icon: WarningRegular,
    pattern: 'dots',
    description: 'Outcome or support is not yet established',
  },
  unsupported: {
    label: 'Unsupported',
    tone: 'unsupported',
    icon: DismissCircleRegular,
    pattern: 'crosshatch',
    description: 'Not supported by the available evidence',
  },
  missing: {
    label: 'Missing',
    tone: 'missing',
    icon: QuestionCircleRegular,
    pattern: 'outline',
    description: 'Expected evidence has not been collected',
  },
  neutral: {
    label: 'Neutral',
    tone: 'neutral',
    icon: InfoRegular,
    pattern: 'solid',
    description: 'No quality judgement attached',
  },
};

export const BADGE_STATUSES = Object.keys(STATUS_META) as BadgeStatus[];
