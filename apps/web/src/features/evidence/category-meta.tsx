'use client';

import { EVIDENCE_CATEGORY_LABELS, type EvidenceCategory } from '@caseguard/schemas';
import { Badge, cg, patternBackground, type PatternKind, type ToneName } from '@caseguard/ui';
import {
  CircleCheckIcon,
  CircleHelpIcon,
  CircleXIcon,
  FileSearchIcon,
  FlaskConicalIcon,
  LightbulbIcon,
  TriangleAlertIcon,
  UserIcon,
  type LucideIcon,
} from 'lucide-react';
import type { CSSProperties } from 'react';

export interface CategoryMeta {
  icon: LucideIcon;
  tone: ToneName;
  /** The texture of its swatch in the coverage bar: colour is never the only way to tell two categories apart. */
  pattern: PatternKind;
  /** A dashed outline marks what is absent or is not part of the case itself. */
  dashed: boolean;
  /** One plain sentence on what the category means (a tooltip, never the only explanation). */
  meaning: string;
}

/** One look per evidence category: icon, tone, texture and a plain meaning, so no category depends on colour alone. */
export const CATEGORY_META: Record<EvidenceCategory, CategoryMeta> = {
  confirmed_fact: {
    icon: CircleCheckIcon,
    tone: 'productive',
    pattern: 'solid',
    dashed: false,
    meaning: 'Checked against the record.',
  },
  customer_reported: {
    icon: UserIcon,
    tone: 'evidence',
    pattern: 'solid',
    dashed: false,
    meaning: 'What the customer said. Not checked yet.',
  },
  engineer_assumption: {
    icon: TriangleAlertIcon,
    tone: 'uncertain',
    pattern: 'dots',
    dashed: false,
    meaning: 'A statement with no evidence behind it.',
  },
  diagnostic_evidence: {
    icon: FileSearchIcon,
    tone: 'evidence',
    pattern: 'hatch',
    dashed: false,
    meaning: 'Comes from logs, traces or tool output.',
  },
  ai_inference: {
    icon: LightbulbIcon,
    tone: 'hypothesis',
    pattern: 'solid',
    dashed: false,
    meaning: 'A conclusion drawn from the other claims.',
  },
  conflicting_evidence: {
    icon: CircleXIcon,
    tone: 'unsupported',
    pattern: 'crosshatch',
    dashed: false,
    meaning: 'Contradicts another claim.',
  },
  missing_evidence: {
    icon: CircleHelpIcon,
    tone: 'missing',
    pattern: 'outline',
    dashed: true,
    meaning: 'Needed, and not collected.',
  },
  simulated_outcome: {
    icon: FlaskConicalIcon,
    tone: 'simulated',
    pattern: 'hatch',
    dashed: true,
    meaning: 'From a what-if path. Never from the case itself.',
  },
};

export interface EvidenceCategoryBadgeProps {
  category: EvidenceCategory;
  size?: 'sm' | 'md';
}

/** The category of a claim as a pill: icon, name and the same tone and outline everywhere it appears. */
export function EvidenceCategoryBadge({ category, size = 'sm' }: EvidenceCategoryBadgeProps) {
  const meta = CATEGORY_META[category];
  const Icon = meta.icon;
  return (
    <Badge
      tone={meta.tone}
      icon={<Icon />}
      size={size}
      dashed={meta.dashed}
      outlined={category === 'missing_evidence'}
      title={meta.meaning}
    >
      {EVIDENCE_CATEGORY_LABELS[category]}
    </Badge>
  );
}

/**
 * The fill of a category's swatch (a segment of the coverage bar, a key in its legend): solid, or a texture over the
 * tone's tint, or a dashed outline. Only tokens and the shared texture vocabulary are used.
 */
export function categoryPaint(category: EvidenceCategory): CSSProperties {
  const { tone, pattern } = CATEGORY_META[category];
  const colors = cg.tone[tone];
  if (pattern === 'solid') return { backgroundColor: colors.solid, borderColor: colors.solid };
  if (pattern === 'outline') {
    return { backgroundColor: 'transparent', borderColor: colors.border, borderStyle: 'dashed' };
  }
  return { ...patternBackground(pattern, tone), borderColor: colors.solid };
}
