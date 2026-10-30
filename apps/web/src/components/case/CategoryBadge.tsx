'use client';

import { EVIDENCE_CATEGORY_LABELS, type EvidenceCategory } from '@caseguard/schemas';
import { BadgeShell, type PatternKind, type ToneName } from '@caseguard/ui';
import {
  BeakerRegular,
  CheckmarkCircleRegular,
  DismissCircleRegular,
  DocumentSearchRegular,
  LightbulbRegular,
  PersonRegular,
  QuestionCircleRegular,
  WarningRegular,
  type FluentIcon,
} from '@fluentui/react-icons';
import type { CSSProperties } from 'react';

interface CategoryLook {
  tone: ToneName;
  pattern: PatternKind;
  icon: FluentIcon;
  borderStyle: CSSProperties['borderStyle'];
  outlined: boolean;
}

/** One look per evidence category: tone + pattern + icon + label, so no category relies on colour alone. */
export const CATEGORY_LOOKS: Record<EvidenceCategory, CategoryLook> = {
  confirmed_fact: {
    tone: 'productive',
    pattern: 'solid',
    icon: CheckmarkCircleRegular,
    borderStyle: 'solid',
    outlined: false,
  },
  customer_reported: {
    tone: 'evidence',
    pattern: 'solid',
    icon: PersonRegular,
    borderStyle: 'solid',
    outlined: false,
  },
  engineer_assumption: {
    tone: 'uncertain',
    pattern: 'dots',
    icon: WarningRegular,
    borderStyle: 'solid',
    outlined: false,
  },
  diagnostic_evidence: {
    tone: 'evidence',
    pattern: 'hatch',
    icon: DocumentSearchRegular,
    borderStyle: 'solid',
    outlined: false,
  },
  ai_inference: {
    tone: 'hypothesis',
    pattern: 'solid',
    icon: LightbulbRegular,
    borderStyle: 'solid',
    outlined: false,
  },
  conflicting_evidence: {
    tone: 'unsupported',
    pattern: 'crosshatch',
    icon: DismissCircleRegular,
    borderStyle: 'solid',
    outlined: false,
  },
  missing_evidence: {
    tone: 'missing',
    pattern: 'outline',
    icon: QuestionCircleRegular,
    borderStyle: 'dashed',
    outlined: true,
  },
  simulated_outcome: {
    tone: 'simulated',
    pattern: 'hatch',
    icon: BeakerRegular,
    borderStyle: 'dashed',
    outlined: false,
  },
};

export interface CategoryBadgeProps {
  category: EvidenceCategory;
  size?: 'small' | 'medium';
  className?: string;
}

/** Evidence-category pill following the visual grammar (tone, pattern, icon and the category name). */
export function CategoryBadge({ category, size = 'small', className }: CategoryBadgeProps) {
  const look = CATEGORY_LOOKS[category];
  const Icon = look.icon;
  return (
    <BadgeShell
      tone={look.tone}
      pattern={look.pattern}
      icon={<Icon />}
      label={EVIDENCE_CATEGORY_LABELS[category]}
      size={size}
      borderStyle={look.borderStyle}
      outlined={look.outlined}
      {...(className ? { className } : {})}
    />
  );
}
