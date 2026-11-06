'use client';

import type { SkillDetail } from '@caseguard/schemas';
import {
  Accordion,
  AccordionItem,
  BentoGrid,
  BentoItem,
  Badge,
  CopyButton,
  KeyValueList,
  Panel,
  ProvenanceBadge,
  RelativeTime,
  cg,
  formatProbability,
} from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';
import { ExpandableText } from '../../components/case/ExpandableText';
import { DefinitionSections, ProvenanceLinks } from './DefinitionSections';
import { useSkillStyles } from './styles';

const useStyles = makeStyles({
  description: { color: cg.textSecondary },
});

function About({ detail }: { detail: SkillDetail }) {
  const styles = useSkillStyles();
  const own = useStyles();
  const { skill, currentVersion } = detail;
  const content = currentVersion.content;
  const benefit = content.expectedBenefit;
  return (
    <Panel
      title="About this skill"
      description={`${content.product} · ${content.workload}`}
      help="The skill as it is in its current version. Estimated success is a model estimate, capped when few cases support it; it is never a measurement."
    >
      <ExpandableText
        text={content.description}
        lines={4}
        label="skill description"
        className={own.description}
      />
      <KeyValueList
        aria-label="About this skill"
        layout="inline"
        items={[
          {
            id: 'confidence',
            label: 'Estimated success',
            value: (
              <>
                {formatProbability(content.confidence.score, 0)}{' '}
                <ProvenanceBadge kind="estimated" size="small" />
              </>
            ),
            hint: content.confidence.rationale,
          },
          { id: 'version', label: 'Current version', value: currentVersion.version },
          {
            id: 'validated',
            label: 'Last validated',
            value: skill.lastValidatedAt ? (
              <RelativeTime value={skill.lastValidatedAt} />
            ) : (
              'Not validated yet'
            ),
          },
          { id: 'created', label: 'Created', value: <RelativeTime value={skill.createdAt} /> },
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
        <div className={styles.tight}>
          <h3 className={styles.title}>Where it applies</h3>
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
        </div>
      ) : null}
      {benefit || detail.notices.length > 0 ? (
        <Accordion>
          {benefit ? (
            <AccordionItem title="How the benefit was estimated" headingLevel={3}>
              <div className={styles.tight}>
                <p className={styles.text}>{benefit.basis}</p>
                <ul className={styles.bullets} aria-label="Caveats">
                  {benefit.caveats.map((caveat) => (
                    <li key={caveat}>{caveat}</li>
                  ))}
                </ul>
              </div>
            </AccordionItem>
          ) : null}
          {detail.notices.length > 0 ? (
            <AccordionItem
              title="Notes on this skill"
              headingLevel={3}
              badge={
                <Badge tone="neutral" size="sm">
                  {detail.notices.length}
                </Badge>
              }
            >
              <ul className={styles.bullets} aria-label="Notes on this skill">
                {detail.notices.map((notice) => (
                  <li key={notice}>{notice}</li>
                ))}
              </ul>
            </AccordionItem>
          ) : null}
        </Accordion>
      ) : null}
    </Panel>
  );
}

function Source({ detail }: { detail: SkillDetail }) {
  const styles = useSkillStyles();
  const content = detail.currentVersion.content;
  const provenance = content.provenance;
  if (!provenance) return null;
  const hindsightParts = provenance.hindsight.parts.length;
  return (
    <Panel
      title="Where it came from"
      description="The case, decision point and simulated path the skill was extracted from."
      help="Parts of a skill that were derived with knowledge of the recorded resolution are listed separately, with the notice the API gives about how they are used. Everything else was derived only from what was known at the decision time."
    >
      <KeyValueList
        aria-label="Source"
        layout="inline"
        items={[
          { id: 'case', label: 'Source case', value: provenance.caseReference },
          { id: 'strategy', label: 'Strategy', value: provenance.strategy ?? 'Not recorded' },
          {
            id: 'extracted',
            label: 'Extracted',
            value: <RelativeTime value={provenance.extractedAt} />,
          },
        ]}
      />
      <ProvenanceLinks content={content} />
      <Accordion>
        <AccordionItem
          title="What was known when"
          headingLevel={3}
          lazy={false}
          subtitle={
            provenance.hindsight.used
              ? `${hindsightParts} ${hindsightParts === 1 ? 'part was' : 'parts were'} derived with hindsight`
              : 'No part was derived with hindsight'
          }
        >
          <div className={styles.stack}>
            <div className={styles.tight}>
              <p className={styles.title}>Derived only from what was known at the decision time</p>
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
            </div>
            {provenance.hindsight.used ? (
              <div className={styles.hindsight} role="group" aria-label="Derived with hindsight">
                <p className={styles.hindsightTitle}>Derived with hindsight</p>
                <p className={styles.caption}>{provenance.hindsight.notice}</p>
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
          </div>
        </AccordionItem>
      </Accordion>
    </Panel>
  );
}

/** The "Overview" tab: what the skill is and where it applies, where it came from, and every part of its definition. */
export function DefinitionTab({ detail }: { detail: SkillDetail }) {
  const styles = useSkillStyles();
  const content = detail.currentVersion.content;
  return (
    <div className={styles.page}>
      <BentoGrid>
        <BentoItem span={12} spanLg={content.provenance ? 7 : 12}>
          <About detail={detail} />
        </BentoItem>
        {content.provenance ? (
          <BentoItem span={12} spanLg={5}>
            <Source detail={detail} />
          </BentoItem>
        ) : null}
      </BentoGrid>
      <Panel
        title="The skill in detail"
        description={`Version ${detail.currentVersion.version}: open any part to read it.`}
      >
        <DefinitionSections content={content} />
      </Panel>
    </div>
  );
}
