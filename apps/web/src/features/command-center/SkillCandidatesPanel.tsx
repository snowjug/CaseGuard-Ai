'use client';

import { SKILL_LIFECYCLE_LABELS, type SkillDna } from '@caseguard/schemas';
import {
  BadgeShell,
  EmptyState,
  Panel,
  ProvenanceBadge,
  UiLink,
  formatProbability,
} from '@caseguard/ui';
import { MoleculeRegular } from '@fluentui/react-icons';
import { usePanelStyles } from './panel-styles';

export function SkillCandidatesPanel({ skills }: { skills: readonly SkillDna[] }) {
  const styles = usePanelStyles();
  return (
    <Panel
      title="Skill candidates"
      description="Reusable skills generated from investigations, waiting for validation and review."
      accent="skill"
      footer={
        <UiLink href="/skills" className={styles.link}>
          Open the SkillDNA Library
        </UiLink>
      }
    >
      {skills.length === 0 ? (
        <EmptyState
          compact
          headingLevel={3}
          icon={<MoleculeRegular />}
          title="No skill candidates yet"
          description="Skills are extracted from analysed cases. Analyse a case, then extract a skill from its investigation path."
        />
      ) : (
        <ul className={styles.list}>
          {skills.map((skill) => (
            <li key={skill.id} className={styles.item}>
              <div className={styles.itemHead}>
                <BadgeShell
                  tone="skill"
                  pattern="solid"
                  icon={<MoleculeRegular />}
                  label={SKILL_LIFECYCLE_LABELS[skill.lifecycle]}
                  size="small"
                />
                {skill.synthetic ? <ProvenanceBadge kind="synthetic" /> : null}
              </div>
              <h3 className={styles.itemTitle}>
                <UiLink href={`/skills/${encodeURIComponent(skill.id)}`} className={styles.link}>
                  {skill.name}
                </UiLink>
              </h3>
              <p className={styles.itemText}>{skill.description}</p>
              <p className={styles.meta}>
                v{skill.currentVersion} · {skill.workload} · owner {skill.owner} · confidence{' '}
                {formatProbability(skill.confidence)} (estimated)
              </p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
