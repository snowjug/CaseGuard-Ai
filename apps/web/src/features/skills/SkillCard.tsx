'use client';

import type { SkillDna, SkillValidationStatus } from '@caseguard/schemas';
import {
  KeyValueList,
  ProvenanceBadge,
  StatusBadge,
  UiLink,
  formatDateUtc,
  formatProbability,
} from '@caseguard/ui';
import { MoleculeRegular } from '@fluentui/react-icons';
import { formatNumber } from '../../lib/format';
import { ClampedText } from '../quality/ClampedText';
import { useInsightStyles } from '../quality/styles';
import { LIFECYCLE_BADGES } from './labels';

export const VALIDATION_STATUS_LABELS: Record<SkillValidationStatus, string> = {
  unvalidated: 'Not validated yet',
  simulation_passed: 'Simulation test passed',
  expert_reviewed: 'Expert reviewed',
  pilot_validated: 'Pilot validated',
  validated: 'Validated',
};

/**
 * One skill in the library: what it is, where it stands in its lifecycle and how far to trust it (an estimate).
 * `headingLevel` is 2 where the cards follow the page title directly, and 3 inside a panel.
 */
export function SkillCard({ skill, headingLevel = 3 }: { skill: SkillDna; headingLevel?: 2 | 3 }) {
  const styles = useInsightStyles();
  const lifecycle = LIFECYCLE_BADGES[skill.lifecycle];
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <li className={styles.item}>
      <div className={styles.itemHead}>
        <MoleculeRegular aria-hidden="true" />
        <Heading className={styles.itemTitle}>
          <UiLink href={`/skills/${encodeURIComponent(skill.id)}`} className={styles.link}>
            {skill.name}
          </UiLink>
        </Heading>
        <span className={styles.meta}>version {skill.currentVersion}</span>
      </div>
      <div className={styles.itemHead}>
        <StatusBadge status={lifecycle.status} label={lifecycle.label} size="small" />
        {skill.hasProposedMutation ? (
          <StatusBadge status="uncertain" label="Change proposed" size="small" />
        ) : null}
        {skill.synthetic ? <ProvenanceBadge kind="synthetic" size="small" /> : null}
      </div>
      <ClampedText text={skill.description} lines={2} label={`description of ${skill.name}`} />
      <KeyValueList
        aria-label={`Facts about ${skill.name}`}
        columns={3}
        items={[
          { id: 'workload', label: 'Workload', value: `${skill.product} · ${skill.workload}` },
          {
            id: 'confidence',
            label: 'Confidence (estimate)',
            value: formatProbability(skill.confidence, 0),
          },
          {
            id: 'validation',
            label: 'Validation',
            value: VALIDATION_STATUS_LABELS[skill.validationStatus],
            hint: skill.lastValidatedAt
              ? `Last validated ${formatDateUtc(skill.lastValidatedAt)}`
              : undefined,
          },
          {
            id: 'sources',
            label: 'Source cases',
            value: formatNumber(skill.sourceCaseIds.length, { maximumFractionDigits: 0 }),
          },
          {
            id: 'applications',
            label: 'Applied to cases',
            value: formatNumber(skill.effectiveness.applications, { maximumFractionDigits: 0 }),
            hint: skill.effectiveness.synthetic
              ? 'Synthetic data: demonstrates the pipeline'
              : undefined,
          },
        ]}
      />
    </li>
  );
}
