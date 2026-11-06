'use client';

import type { SkillCondition, SkillContent } from '@caseguard/schemas';
import {
  Accordion,
  AccordionItem,
  Badge,
  CopyButton,
  UiLink,
  cg,
  formatProbability,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { HistoryIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { evidenceLinkHref } from '../../lib/deep-links';
import { HINDSIGHT_LABEL } from './labels';
import { useSkillStyles } from './styles';

const HINDSIGHT_MARK = /\(hindsight-informed\)/i;

const useStyles = makeStyles({
  stepTitle: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
  },
  branches: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    margin: 0,
    padding: `${cg.space[1]} 0 0 ${cg.space[4]}`,
    listStyle: 'none',
    borderLeft: `2px solid ${cg.borderSubtle}`,
  },
  branch: { display: 'flex', flexDirection: 'column', gap: cg.space[1], minWidth: 0 },
  // One quiet line per branch: the long explanation is said once, above the steps.
  hindsightLine: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: cg.space[2],
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    color: cg.tone.uncertain.fg,
    '& > svg': { flexShrink: 0, marginTop: cg.space[1] },
  },
  hindsightTitle: { fontWeight: tokens.fontWeightSemibold },
});

function Section({
  title,
  count,
  defaultOpen = false,
  children,
}: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <AccordionItem
      title={title}
      headingLevel={3}
      defaultOpen={defaultOpen}
      badge={
        count !== undefined ? (
          <Badge tone="neutral" size="sm">
            {count}
          </Badge>
        ) : undefined
      }
    >
      {children}
    </AccordionItem>
  );
}

function Conditions({
  conditions,
  hindsightPaths,
  group,
}: {
  conditions: readonly SkillCondition[];
  hindsightPaths: readonly string[];
  group: 'triggerConditions' | 'exclusions';
}) {
  const styles = useSkillStyles();
  if (conditions.length === 0) return <p className={styles.text}>None.</p>;
  return (
    <ul className={styles.rows}>
      {conditions.map((condition) => {
        const hindsight =
          HINDSIGHT_MARK.test(condition.description) ||
          hindsightPaths.includes(`${group}.${condition.id}`) ||
          hindsightPaths.includes(group);
        return (
          <li key={condition.id} className={styles.rowItem}>
            <div className={styles.rowHead}>
              <Badge tone={condition.required ? 'brand' : 'neutral'} size="sm">
                {condition.required ? 'Required' : 'Optional'}
              </Badge>
              {hindsight ? (
                <Badge tone="uncertain" icon={<HistoryIcon />} size="sm">
                  {HINDSIGHT_LABEL}
                </Badge>
              ) : null}
              <span className={styles.meta}>weight {formatProbability(condition.weight, 0)}</span>
            </div>
            <p className={styles.text}>{condition.description}</p>
            {condition.kind === 'text' && condition.pattern ? (
              <p className={styles.mono}>Pattern: {condition.pattern}</p>
            ) : null}
            {condition.kind === 'signal' && condition.signalId ? (
              <p className={styles.meta}>Signal: {condition.signalId}</p>
            ) : null}
            {condition.kind === 'attribute' && condition.attribute ? (
              <p className={styles.meta}>Case attribute: {condition.attribute}</p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function TextList({ items, empty }: { items: readonly string[]; empty: string }) {
  const styles = useSkillStyles();
  if (items.length === 0) return <p className={styles.text}>{empty}</p>;
  return (
    <ul className={styles.bullets}>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function DecisionSequence({ content }: { content: SkillContent }) {
  const styles = useSkillStyles();
  const own = useStyles();
  const anyHindsightEstimate = content.decisionSequence.some((step) =>
    step.branches.some((branch) => branch.hindsightProbability !== undefined),
  );
  const titleOf = (next: string): string => {
    if (next === 'stop') return 'Stop';
    if (next === 'escalate') return 'Escalate';
    if (next === 'success') return 'Success';
    return content.decisionSequence.find((step) => step.id === next)?.title ?? next;
  };
  return (
    <div className={styles.stack}>
      {anyHindsightEstimate ? (
        <p className={styles.caption}>
          Hindsight estimates use the recorded cause of the source case. They only calibrate the
          decision-time estimates: a branch probability like this does not count towards a match or
          towards the steps the skill recommends.
        </p>
      ) : null}
      <ol className={styles.rows}>
        {[...content.decisionSequence]
          .sort((a, b) => a.order - b.order)
          .map((step) => (
            <li key={step.id} className={styles.rowItem}>
              <h4 className={own.stepTitle}>
                {step.order}. {step.title}
              </h4>
              <p className={styles.text}>{step.instruction}</p>
              <p className={styles.meta}>
                {step.actionKey ? `Action ${step.actionKey}` : 'No catalogued action'}
                {step.expectedInformationGainBits !== null
                  ? ` · expected information gain ${step.expectedInformationGainBits} bits (estimate)`
                  : ''}
                {step.requiresInputs.length > 0 ? ` · needs ${step.requiresInputs.join(', ')}` : ''}
              </p>
              {step.branches.length > 0 ? (
                <ul className={own.branches} aria-label={`Branches after ${step.title}`}>
                  {step.branches.map((branch) => (
                    <li key={`${branch.condition}:${branch.next}`} className={own.branch}>
                      <p className={styles.text}>
                        <span className={styles.strong}>If</span> {branch.condition}{' '}
                        <span className={styles.strong}>then</span> {titleOf(branch.next)}
                      </p>
                      <p className={styles.meta}>{branch.rationale}</p>
                      {branch.probability !== undefined ? (
                        <p className={styles.meta}>
                          Decision-time estimate: {formatProbability(branch.probability, 0)} that
                          this outcome occurs.
                        </p>
                      ) : null}
                      {branch.hindsightProbability !== undefined ? (
                        <p className={own.hindsightLine}>
                          <HistoryIcon aria-hidden="true" />
                          <span>
                            <span className={own.hindsightTitle}>
                              Hindsight estimate (uses the recorded cause)
                            </span>{' '}
                            <span>
                              {formatProbability(branch.hindsightProbability, 0)} given the recorded
                              root cause of the source case.
                            </span>
                          </span>
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
      </ol>
    </div>
  );
}

export interface DefinitionSectionsProps {
  content: SkillContent;
}

/** The parts of the current version, each in an accordion: what triggers it, what it does, what it must never do. */
export function DefinitionSections({ content }: DefinitionSectionsProps) {
  const styles = useSkillStyles();
  const hindsightPaths = content.provenance?.hindsight.parts ?? [];
  return (
    <Accordion>
      <Section title="Trigger conditions" count={content.triggerConditions.length} defaultOpen>
        <Conditions
          conditions={content.triggerConditions}
          hindsightPaths={hindsightPaths}
          group="triggerConditions"
        />
      </Section>
      <Section title="Exclusions" count={content.exclusions.length}>
        <Conditions
          conditions={content.exclusions}
          hindsightPaths={hindsightPaths}
          group="exclusions"
        />
      </Section>
      <Section title="Decision sequence" count={content.decisionSequence.length} defaultOpen>
        <DecisionSequence content={content} />
      </Section>
      <Section title="Required inputs" count={content.requiredInputs.length}>
        {content.requiredInputs.length === 0 ? (
          <p className={styles.text}>None.</p>
        ) : (
          <ul className={styles.bullets}>
            {content.requiredInputs.map((input) => (
              <li key={input.key}>
                <span className={styles.strong}>{input.label}</span>
                {input.required ? ' (required)' : ' (optional)'}: {input.description}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Minimum evidence" count={content.minimumEvidence.length}>
        {content.minimumEvidence.length === 0 ? (
          <p className={styles.text}>None.</p>
        ) : (
          <ul className={styles.bullets}>
            {content.minimumEvidence.map((item) => (
              <li key={item.requirementId}>
                <span className={styles.strong}>{item.label}</span>: {item.description}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Candidate actions" count={content.candidateActions.length}>
        {content.candidateActions.length === 0 ? (
          <p className={styles.text}>None.</p>
        ) : (
          <ul className={styles.rows}>
            {content.candidateActions.map((action) => (
              <li key={action.actionKey} className={styles.rowItem}>
                <p className={styles.title}>{action.label}</p>
                <p className={styles.text}>{action.whenToUse}</p>
                <p className={styles.meta}>
                  Risk {action.risk} · customer effort {action.customerEffort.replace('_', ' ')} ·{' '}
                  {action.requiresApproval ? 'needs approval' : 'no approval needed'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="When to stop, succeed or escalate">
        <div className={styles.stack}>
          <div className={styles.tight}>
            <p className={styles.title}>Stop conditions</p>
            <TextList items={content.stopConditions} empty="None." />
          </div>
          <div className={styles.tight}>
            <p className={styles.title}>Success conditions</p>
            <TextList items={content.successConditions} empty="None." />
          </div>
          <div className={styles.tight}>
            <p className={styles.title}>Escalation conditions</p>
            <TextList items={content.escalationConditions} empty="None." />
          </div>
        </div>
      </Section>
      <Section title="Safety constraints" count={content.safetyConstraints.length} defaultOpen>
        <TextList items={content.safetyConstraints} empty="None." />
      </Section>
      <Section title="Query templates" count={content.queryTemplates.length}>
        <div className={styles.stack}>
          {content.queryTemplates.length === 0 ? (
            <p className={styles.text}>None.</p>
          ) : (
            <ul className={styles.rows}>
              {content.queryTemplates.map((template) => (
                <li key={template.id} className={styles.rowItem}>
                  <div className={styles.rowHead}>
                    <p className={styles.title}>{template.title}</p>
                    <Badge tone="neutral" size="sm">
                      {template.language === 'kql' ? 'KQL' : 'PowerShell'}
                    </Badge>
                    <CopyButton value={template.template} label={`Copy ${template.title}`} />
                  </div>
                  <p className={styles.text}>{template.description}</p>
                  <pre className={styles.code}>{template.template}</pre>
                  {template.parameters.length > 0 ? (
                    <ul className={styles.bullets} aria-label="Parameters">
                      {template.parameters.map((parameter) => (
                        <li key={parameter.name}>
                          <span className={styles.mono}>{`{{${parameter.name}}}`}</span>:{' '}
                          {parameter.description}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <p className={styles.meta}>Safety: {template.safetyNote}</p>
                </li>
              ))}
            </ul>
          )}
          <p className={styles.meta}>
            Templates use placeholders and never contain customer data. Run them only in an
            environment you are allowed to query.
          </p>
        </div>
      </Section>
      <Section title="Known failure modes" count={content.knownFailureModes.length}>
        <TextList items={content.knownFailureModes} empty="None recorded." />
      </Section>
      <Section title="Source cases" count={content.sourceCases.length}>
        <ul className={styles.rows}>
          {content.sourceCases.map((source) => (
            <li key={`${source.caseId}:${source.role}`} className={styles.rowItem}>
              <UiLink href={`/cases/${encodeURIComponent(source.caseId)}`} className={styles.link}>
                {source.reference}
              </UiLink>
              <p className={styles.meta}>
                {source.role === 'origin'
                  ? 'Where the skill came from'
                  : source.role === 'validation'
                    ? 'Used to validate it'
                    : 'Where a proposed change came from'}
              </p>
            </li>
          ))}
        </ul>
      </Section>
      {content.cheaperAlternatives && content.cheaperAlternatives.length > 0 ? (
        <Section
          title="Cheaper ways to learn the same thing"
          count={content.cheaperAlternatives.length}
        >
          <ul className={styles.rows}>
            {content.cheaperAlternatives.map((alternative) => (
              <li
                key={`${alternative.insteadOfActionKey}:${alternative.useActionKey}`}
                className={styles.rowItem}
              >
                <p className={styles.text}>
                  Instead of <span className={styles.strong}>{alternative.insteadOfLabel}</span>,
                  use <span className={styles.strong}>{alternative.useLabel}</span>.
                </p>
                <p className={styles.meta}>{alternative.rationale}</p>
                {alternative.estimatedCustomerMinutesSaved !== null ? (
                  <p className={styles.meta}>
                    About {alternative.estimatedCustomerMinutesSaved} customer minutes saved
                    (estimated).
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {content.validationCriteria && content.validationCriteria.length > 0 ? (
        <Section title="What validation checks" count={content.validationCriteria.length}>
          <TextList items={content.validationCriteria} empty="None." />
        </Section>
      ) : null}
    </Accordion>
  );
}

/** Links from the source block to the case, fork and scenario the skill was extracted from. */
export function ProvenanceLinks({ content }: { content: SkillContent }) {
  const styles = useSkillStyles();
  const provenance = content.provenance;
  if (!provenance) return null;
  return (
    <ul className={styles.chips} aria-label="Where the skill came from">
      <li>
        <UiLink href={`/cases/${encodeURIComponent(provenance.caseId)}`} className={styles.chip}>
          {provenance.caseReference}
        </UiLink>
      </li>
      {provenance.forkId ? (
        <li>
          <UiLink
            href={evidenceLinkHref(provenance.caseId, { type: 'fork', id: provenance.forkId })}
            className={styles.chip}
          >
            Key decision
          </UiLink>
        </li>
      ) : null}
      {provenance.scenarioId ? (
        <li>
          <UiLink
            href={evidenceLinkHref(provenance.caseId, {
              type: 'scenario',
              id: provenance.scenarioId,
            })}
            className={styles.chip}
          >
            Accepted simulated path
          </UiLink>
        </li>
      ) : null}
    </ul>
  );
}
