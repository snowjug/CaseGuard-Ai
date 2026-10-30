'use client';

import {
  SYNTHETIC_EFFECTIVENESS_NOTICE,
  type SkillDetail,
  type SkillExpectedBenefit,
} from '@caseguard/schemas';
import {
  CopyButton,
  KeyValueList,
  Notice,
  Panel,
  ProvenanceBadge,
  RangeBar,
  formatDateTimeUtc,
  formatDuration,
  formatProbability,
} from '@caseguard/ui';
import { formatNumber } from '../../lib/format';
import { ClampedText } from '../quality/ClampedText';
import { useInsightStyles } from '../quality/styles';
import { DefinitionSections, ProvenanceLinks } from './DefinitionSections';

function range(
  values: SkillExpectedBenefit['timeSavedMinutes'],
  unit: (n: number) => string,
): string {
  return `${unit(values.mid)} (range ${unit(values.low)} to ${unit(values.high)})`;
}

function Overview({ detail }: { detail: SkillDetail }) {
  const styles = useInsightStyles();
  const { skill, currentVersion } = detail;
  const content = currentVersion.content;
  return (
    <Panel
      title="About this skill"
      description={`${content.product} · ${content.workload}`}
      help="The skill as it is in its current version. Confidence is a model estimate, capped when few cases support it; it is never a measurement."
      actions={<ProvenanceBadge kind="estimated" label="Estimated confidence" />}
    >
      <ClampedText text={content.description} lines={5} label="skill description" />
      <KeyValueList
        aria-label="About this skill"
        layout="inline"
        items={[
          { id: 'version', label: 'Current version', value: currentVersion.version },
          {
            id: 'confidence',
            label: 'Confidence (estimate)',
            value: formatProbability(content.confidence.score, 0),
            hint: content.confidence.rationale,
          },
          {
            id: 'validated',
            label: 'Last validated',
            value: skill.lastValidatedAt
              ? formatDateTimeUtc(skill.lastValidatedAt)
              : 'Not validated yet',
          },
          { id: 'created', label: 'Created', value: formatDateTimeUtc(skill.createdAt) },
          {
            id: 'skill-id',
            label: 'Skill ID',
            mono: true,
            value: (
              <>
                {skill.id}
                <CopyButton value={skill.id} label="Copy the skill ID" />
              </>
            ),
          },
        ]}
      />
      {content.applicability ? (
        <>
          <p className={styles.itemTitle}>Where it applies</p>
          <p className={styles.text}>{content.applicability.scope}</p>
          <p className={styles.meta}>
            Validated on {content.applicability.validatedOnCases}{' '}
            {content.applicability.validatedOnCases === 1 ? 'case' : 'cases'}.
          </p>
          {content.applicability.limitations.length > 0 ? (
            <ul className={styles.bullets} aria-label="Limitations">
              {content.applicability.limitations.map((limitation) => (
                <li key={limitation}>{limitation}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </Panel>
  );
}

function Benefit({ benefit }: { benefit: SkillExpectedBenefit }) {
  const styles = useInsightStyles();
  const minutes = (n: number): string => formatDuration(n);
  const count = (n: number): string => formatNumber(n, { maximumFractionDigits: 0 });
  return (
    <Panel
      title="Expected benefit"
      description="What following the skill would save, according to a simulation."
      help="A replay of the skill at the source decision point, compared with the recorded path of the source case. Nothing was executed, and the step outcomes use the recorded cause, so the figures are estimates that only demonstrate the method."
      actions={
        <>
          <ProvenanceBadge kind="estimated" />
          <ProvenanceBadge kind="simulated" />
        </>
      }
    >
      <KeyValueList
        aria-label="Expected benefit"
        layout="inline"
        items={[
          {
            id: 'time',
            label: 'Time to diagnosis',
            value: range(benefit.timeSavedMinutes, minutes),
          },
          {
            id: 'effort',
            label: 'Customer effort',
            value: range(benefit.customerEffortSavedMinutes, minutes),
          },
          { id: 'tokens', label: 'Tokens', value: range(benefit.tokensSaved, count) },
        ]}
      />
      <RangeBar
        value={benefit.timeSavedMinutes.mid}
        low={benefit.timeSavedMinutes.low}
        high={benefit.timeSavedMinutes.high}
        min={0}
        max={Math.max(benefit.timeSavedMinutes.high * 1.1, 1)}
        label="Estimated time saved"
        format={minutes}
      />
      <p className={styles.text}>{benefit.basis}</p>
      <ul className={styles.bullets} aria-label="Caveats">
        {benefit.caveats.map((caveat) => (
          <li key={caveat}>{caveat}</li>
        ))}
      </ul>
    </Panel>
  );
}

function Provenance({ detail }: { detail: SkillDetail }) {
  const styles = useInsightStyles();
  const content = detail.currentVersion.content;
  const provenance = content.provenance;
  if (!provenance) return null;
  return (
    <Panel
      title="Where it came from"
      description="The case, decision point and simulated path the skill was extracted from."
      help="Parts of a skill that were derived with knowledge of the recorded resolution are listed separately, with the notice the API gives about how they are used. Everything else was derived only from what was known at the decision time."
      actions={
        <>
          {provenance.labels.simulated ? <ProvenanceBadge kind="simulated" /> : null}
          {provenance.labels.estimated ? <ProvenanceBadge kind="estimated" /> : null}
          {provenance.labels.synthetic ? <ProvenanceBadge kind="synthetic" /> : null}
        </>
      }
    >
      <KeyValueList
        aria-label="Provenance"
        layout="inline"
        items={[
          { id: 'case', label: 'Source case', value: provenance.caseReference },
          { id: 'strategy', label: 'Strategy', value: provenance.strategy ?? 'Not recorded' },
          { id: 'extracted', label: 'Extracted', value: formatDateTimeUtc(provenance.extractedAt) },
        ]}
      />
      <ProvenanceLinks content={content} />
      <p className={styles.itemTitle}>Derived only from what was known at the decision time</p>
      {provenance.decisionTimeParts.length === 0 ? (
        <p className={styles.text}>None recorded.</p>
      ) : (
        <ul className={styles.chips} aria-label="Decision-time parts">
          {provenance.decisionTimeParts.map((part) => (
            <li key={part} className={styles.mono}>
              {part}
            </li>
          ))}
        </ul>
      )}
      {provenance.hindsight.used ? (
        <div className={styles.hindsight} role="group" aria-label="Derived with hindsight">
          <p className={styles.hindsightTitle}>Derived with hindsight</p>
          <p className={styles.text}>{provenance.hindsight.notice}</p>
          <ul className={styles.chips} aria-label="Parts derived with hindsight">
            {provenance.hindsight.parts.map((part) => (
              <li key={part} className={styles.mono}>
                {part}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className={styles.text}>No part of this skill was derived with hindsight.</p>
      )}
    </Panel>
  );
}

/** The "Overview" tab: what the skill is, what it expects to achieve, where it came from and every part of its definition. */
export function DefinitionTab({ detail }: { detail: SkillDetail }) {
  const styles = useInsightStyles();
  const content = detail.currentVersion.content;
  return (
    <div className={styles.page}>
      {detail.skill.synthetic ? (
        <Notice variant="synthetic" compact>
          {SYNTHETIC_EFFECTIVENESS_NOTICE}
        </Notice>
      ) : null}
      <div className={styles.band}>
        <Overview detail={detail} />
        {content.expectedBenefit ? <Benefit benefit={content.expectedBenefit} /> : <div />}
      </div>
      <Provenance detail={detail} />
      <Panel
        title="The skill in detail"
        description={`Version ${detail.currentVersion.version}: open any part to read it.`}
      >
        <DefinitionSections content={content} />
      </Panel>
    </div>
  );
}
