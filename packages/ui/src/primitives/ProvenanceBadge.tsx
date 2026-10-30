'use client';

import { BeakerRegular, CalculatorRegular, InfoRegular } from '@fluentui/react-icons';
import { BadgeShell } from './BadgeShell';

export type ProvenanceKind = 'synthetic' | 'estimated' | 'simulated';

export interface ProvenanceBadgeProps {
  /**
   * `synthetic`: generated demo data. `estimated`: a model estimate, never a measured value.
   * `simulated`: a counterfactual / what-if result.
   */
  kind: ProvenanceKind;
  /** Overrides the default text ("Synthetic", "Estimated", "Simulated"). */
  label?: string;
  size?: 'small' | 'medium';
  className?: string;
}

const META: Record<ProvenanceKind, { label: string; description: string }> = {
  synthetic: {
    label: 'Synthetic',
    description: 'Synthetic data: generated for demonstration, never real customer data',
  },
  estimated: {
    label: 'Estimated',
    description: 'Estimated value: a model estimate, not a measured fact',
  },
  simulated: {
    label: 'Simulated',
    description: 'Simulated result: a what-if, not something that happened',
  },
};

/**
 * Honesty badge. Synthetic = outlined with an info icon; Estimated = dotted underline with a calculator icon;
 * Simulated = dashed outline with a hatch chip and a beaker icon.
 */
export function ProvenanceBadge({ kind, label, size = 'small', className }: ProvenanceBadgeProps) {
  const meta = META[kind];
  const common = {
    label: label ?? meta.label,
    size,
    title: meta.description,
    ...(className ? { className } : {}),
  };
  if (kind === 'synthetic') {
    return (
      <BadgeShell {...common} tone="neutral" pattern="outline" icon={<InfoRegular />} outlined />
    );
  }
  if (kind === 'estimated') {
    return (
      <BadgeShell
        {...common}
        tone="neutral"
        pattern="dots"
        icon={<CalculatorRegular />}
        dottedLabel
      />
    );
  }
  return (
    <BadgeShell
      {...common}
      tone="simulated"
      pattern="hatch"
      icon={<BeakerRegular />}
      borderStyle="dashed"
    />
  );
}
