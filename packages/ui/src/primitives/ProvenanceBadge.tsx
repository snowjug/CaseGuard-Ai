'use client';

import { CalculatorIcon, FlaskConicalIcon, InfoIcon } from 'lucide-react';
import { Badge } from '../kit/Badge';

export type ProvenanceKind = 'synthetic' | 'estimated' | 'simulated';

export interface ProvenanceBadgeProps {
  /**
   * `synthetic`: generated demo data. `estimated`: a model estimate, never a measured value.
   * `simulated`: a counterfactual / what-if result.
   */
  kind: ProvenanceKind;
  /** Overrides the default text ("Demo data", "Estimated", "Simulated"). */
  label?: string;
  size?: 'small' | 'medium';
  className?: string;
}

const META: Record<ProvenanceKind, { label: string; description: string }> = {
  synthetic: {
    label: 'Demo data',
    description: 'Synthetic data: generated for demonstration, never real customer data',
  },
  estimated: {
    label: 'Estimated',
    description: 'Estimated value: a model estimate with a range, not a measured fact',
  },
  simulated: {
    label: 'Simulated',
    description: 'Simulated result: a what-if, not something that happened',
  },
};

/**
 * Honesty badge. Demo data = outlined with an info icon; Estimated = dotted underline with a calculator icon;
 * Simulated = dashed accent outline with a flask icon. The full sentence is the tooltip, never a banner.
 */
export function ProvenanceBadge({ kind, label, size = 'small', className }: ProvenanceBadgeProps) {
  const meta = META[kind];
  const common = {
    size: size === 'small' ? ('sm' as const) : ('md' as const),
    title: meta.description,
    ...(className ? { className } : {}),
  };
  const text = label ?? meta.label;
  if (kind === 'synthetic') {
    return (
      <Badge {...common} tone="neutral" icon={<InfoIcon />} outlined>
        {text}
      </Badge>
    );
  }
  if (kind === 'estimated') {
    return (
      <Badge {...common} tone="neutral" icon={<CalculatorIcon />} dotted>
        {text}
      </Badge>
    );
  }
  return (
    <Badge {...common} tone="simulated" icon={<FlaskConicalIcon />} dashed>
      {text}
    </Badge>
  );
}
