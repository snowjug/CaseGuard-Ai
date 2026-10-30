'use client';

import {
  LEADING_HYPOTHESIS_DEFINITION,
  MODEL_ESTIMATE_NOTICE,
  SKILL_MATCH_DEFINITION,
  type CommandCenter,
} from '@caseguard/schemas';
import {
  BadgeShell,
  ConfidenceBand,
  EmptyState,
  Notice,
  Panel,
  ProvenanceBadge,
  StatusBadge,
  UiLink,
  formatProbability,
} from '@caseguard/ui';
import { LightbulbRegular, MoleculeRegular } from '@fluentui/react-icons';
import { caseHref } from '../../lib/deep-links';
import { SKILL_APPLICABILITY } from '../../lib/labels';
import { usePanelStyles } from './panel-styles';

export function HypothesisPanel({
  hypothesis,
}: {
  hypothesis: CommandCenter['leadingHypothesis'];
}) {
  const styles = usePanelStyles();
  return (
    <Panel
      title="Leading hypothesis"
      description="The explanation the evidence currently supports most."
      help={LEADING_HYPOTHESIS_DEFINITION}
      accent="hypothesis"
      footer={
        hypothesis ? (
          <UiLink
            href={`${caseHref(hypothesis.caseId, 'hypotheses')}?sel=${encodeURIComponent(hypothesis.hypothesisId)}`}
            className={styles.link}
          >
            Compare hypotheses
          </UiLink>
        ) : undefined
      }
    >
      {hypothesis ? (
        <>
          <p className={styles.itemTitle}>
            <BadgeShell
              tone="hypothesis"
              pattern="solid"
              icon={<LightbulbRegular />}
              label="Hypothesis"
              size="small"
            />{' '}
            {hypothesis.name}
          </p>
          <ConfidenceBand
            confidence={hypothesis.confidence}
            low={hypothesis.low}
            high={hypothesis.high}
            label={hypothesis.name}
          />
          <Notice variant="model-estimate" compact title={null}>
            {MODEL_ESTIMATE_NOTICE}
          </Notice>
        </>
      ) : (
        <EmptyState
          compact
          headingLevel={3}
          icon={<LightbulbRegular />}
          title="No hypothesis yet"
          description="Run the analysis for this case to see the competing hypotheses and how confident the model is in each."
        />
      )}
    </Panel>
  );
}

export function SkillMatchPanel({ match }: { match: CommandCenter['skillMatch'] }) {
  const styles = usePanelStyles();
  const applicability = match ? SKILL_APPLICABILITY[match.applicability] : null;
  return (
    <Panel
      title="SkillDNA match"
      description="The reusable investigation skill that fits this case best."
      help={SKILL_MATCH_DEFINITION}
      accent="skill"
      footer={
        match ? (
          <UiLink href={`/skills/${encodeURIComponent(match.skillId)}`} className={styles.link}>
            Open the skill
          </UiLink>
        ) : undefined
      }
    >
      {match && applicability ? (
        <>
          <p className={styles.itemTitle}>
            <BadgeShell
              tone="skill"
              pattern="solid"
              icon={<MoleculeRegular />}
              label="SkillDNA"
              size="small"
            />{' '}
            {match.name} <span className={styles.meta}>v{match.version}</span>
          </p>
          <div className={styles.itemHead}>
            <span className={styles.big}>{formatProbability(match.score)}</span>
            <StatusBadge status={applicability.status} label={applicability.label} />
            <ProvenanceBadge kind="estimated" />
          </div>
          <p className={styles.meta}>
            Match score, using only evidence available at the selected time.
          </p>
        </>
      ) : (
        <EmptyState
          compact
          headingLevel={3}
          icon={<MoleculeRegular />}
          title="No matching skill"
          description="No published or validated SkillDNA fits this case yet. Skills are extracted from reviewed investigations."
        />
      )}
    </Panel>
  );
}
