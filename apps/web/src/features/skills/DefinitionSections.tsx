'use client';

import type { SkillCondition, SkillContent } from '@caseguard/schemas';
import { CopyButton, StatusBadge, UiLink } from '@caseguard/ui';
import type { ReactNode } from 'react';
import { evidenceLinkHref } from '../../lib/deep-links';
import { formatProbability } from '../../lib/format';
import { useInsightStyles } from '../quality/styles';

const HINDSIGHT_MARK = /\(hindsight-informed\)/i;

function Collapsible({
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
  const styles = useInsightStyles();
  return (
    <details className={styles.details} open={defaultOpen || undefined}>
      <summary className={styles.summary}>
        {title}
        {count !== undefined ? <span className={styles.meta}>({count})</span> : null}
      </summary>
      <div className={styles.detailsBody}>{children}</div>
    </details>
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
  const styles = useInsightStyles();
  if (conditions.length === 0) return <p className={styles.text}>None.</p>;
  return (
    <ul className={styles.list}>
      {conditions.map((condition) => {
        const hindsight =
          HINDSIGHT_MARK.test(condition.description) ||
          hindsightPaths.includes(`${group}.${condition.id}`) ||
          hindsightPaths.includes(group);
        return (
          <li key={condition.id} className={styles.item}>
            <div className={styles.itemHead}>
              <StatusBadge
                status={condition.required ? 'productive' : 'neutral'}
                label={condition.required ? 'Required' : 'Optional'}
                size="small"
              />
              {hindsight ? (
                <StatusBadge status="uncertain" label="Learned with hindsight" size="small" />
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
  const styles = useInsightStyles();
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
  const styles = useInsightStyles();
  const titleOf = (next: string): string => {
    if (next === 'stop') return 'Stop';
    if (next === 'escalate') return 'Escalate';
    if (next === 'success') return 'Success';
    return content.decisionSequence.find((step) => step.id === next)?.title ?? next;
  };
  return (
    <ol className={styles.list}>
      {[...content.decisionSequence]
        .sort((a, b) => a.order - b.order)
        .map((step) => (
          <li key={step.id} className={styles.item}>
            <h3 className={styles.itemTitle}>
              {step.order}. {step.title}
            </h3>
            <p className={styles.text}>{step.instruction}</p>
            <p className={styles.meta}>
              {step.actionKey ? `Action ${step.actionKey}` : 'No catalogued action'}
              {step.expectedInformationGainBits !== null
                ? ` · expected information gain ${step.expectedInformationGainBits} bits (estimate)`
                : ''}
              {step.requiresInputs.length > 0 ? ` · needs ${step.requiresInputs.join(', ')}` : ''}
            </p>
            {step.branches.length > 0 ? (
              <ul className={styles.list} aria-label={`Branches after ${step.title}`}>
                {step.branches.map((branch) => (
                  <li key={`${branch.condition}:${branch.next}`} className={styles.detailsBody}>
                    <p className={styles.text}>
                      <span className={styles.strong}>If</span> {branch.condition}{' '}
                      <span className={styles.strong}>then</span> {titleOf(branch.next)}
                    </p>
                    <p className={styles.meta}>{branch.rationale}</p>
                    {branch.probability !== undefined ? (
                      <p className={styles.meta}>
                        Decision-time estimate: {formatProbability(branch.probability, 0)} that this
                        outcome occurs.
                      </p>
                    ) : null}
                    {branch.hindsightProbability !== undefined ? (
                      <div className={styles.hindsight}>
                        <p className={styles.hindsightTitle}>
                          Hindsight estimate (uses the recorded cause)
                        </p>
                        <p className={styles.text}>
                          {formatProbability(branch.hindsightProbability, 0)} given the recorded
                          root cause of the source case. It only calibrates the decision-time
                          estimate above: a branch probability like this does not count towards a
                          match or towards the steps the skill recommends.
                        </p>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
    </ol>
  );
}

export interface DefinitionSectionsProps {
  content: SkillContent;
}

/** The parts of the current version, each in a disclosure: what triggers it, what it does, what it must never do. */
export function DefinitionSections({ content }: DefinitionSectionsProps) {
  const styles = useInsightStyles();
  const hindsightPaths = content.provenance?.hindsight.parts ?? [];
  return (
    <div className={styles.stack}>
      <Collapsible title="Trigger conditions" count={content.triggerConditions.length} defaultOpen>
        <Conditions
          conditions={content.triggerConditions}
          hindsightPaths={hindsightPaths}
          group="triggerConditions"
        />
      </Collapsible>
      <Collapsible title="Exclusions" count={content.exclusions.length}>
        <Conditions
          conditions={content.exclusions}
          hindsightPaths={hindsightPaths}
          group="exclusions"
        />
      </Collapsible>
      <Collapsible title="Decision sequence" count={content.decisionSequence.length} defaultOpen>
        <DecisionSequence content={content} />
      </Collapsible>
      <Collapsible title="Required inputs" count={content.requiredInputs.length}>
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
      </Collapsible>
      <Collapsible title="Minimum evidence" count={content.minimumEvidence.length}>
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
      </Collapsible>
      <Collapsible title="Candidate actions" count={content.candidateActions.length}>
        {content.candidateActions.length === 0 ? (
          <p className={styles.text}>None.</p>
        ) : (
          <ul className={styles.list}>
            {content.candidateActions.map((action) => (
              <li key={action.actionKey} className={styles.item}>
                <p className={styles.itemTitle}>{action.label}</p>
                <p className={styles.text}>{action.whenToUse}</p>
                <p className={styles.meta}>
                  Risk {action.risk} · customer effort {action.customerEffort.replace('_', ' ')} ·{' '}
                  {action.requiresApproval ? 'needs approval' : 'no approval needed'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Collapsible>
      <Collapsible title="When to stop, succeed or escalate">
        <p className={styles.itemTitle}>Stop conditions</p>
        <TextList items={content.stopConditions} empty="None." />
        <p className={styles.itemTitle}>Success conditions</p>
        <TextList items={content.successConditions} empty="None." />
        <p className={styles.itemTitle}>Escalation conditions</p>
        <TextList items={content.escalationConditions} empty="None." />
      </Collapsible>
      <Collapsible title="Safety constraints" count={content.safetyConstraints.length} defaultOpen>
        <TextList items={content.safetyConstraints} empty="None." />
      </Collapsible>
      <Collapsible title="Query templates" count={content.queryTemplates.length}>
        {content.queryTemplates.length === 0 ? (
          <p className={styles.text}>None.</p>
        ) : (
          <ul className={styles.list}>
            {content.queryTemplates.map((template) => (
              <li key={template.id} className={styles.item}>
                <div className={styles.itemHead}>
                  <p className={styles.itemTitle}>{template.title}</p>
                  <StatusBadge
                    status="neutral"
                    label={template.language === 'kql' ? 'KQL' : 'PowerShell'}
                    size="small"
                  />
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
      </Collapsible>
      <Collapsible title="Known failure modes" count={content.knownFailureModes.length}>
        <TextList items={content.knownFailureModes} empty="None recorded." />
      </Collapsible>
      <Collapsible title="Source cases" count={content.sourceCases.length}>
        <ul className={styles.list}>
          {content.sourceCases.map((source) => (
            <li key={`${source.caseId}:${source.role}`} className={styles.item}>
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
      </Collapsible>
      {content.cheaperAlternatives && content.cheaperAlternatives.length > 0 ? (
        <Collapsible
          title="Cheaper ways to learn the same thing"
          count={content.cheaperAlternatives.length}
        >
          <ul className={styles.list}>
            {content.cheaperAlternatives.map((alternative) => (
              <li
                key={`${alternative.insteadOfActionKey}:${alternative.useActionKey}`}
                className={styles.item}
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
        </Collapsible>
      ) : null}
      {content.validationCriteria && content.validationCriteria.length > 0 ? (
        <Collapsible title="What validation checks" count={content.validationCriteria.length}>
          <TextList items={content.validationCriteria} empty="None." />
        </Collapsible>
      ) : null}
    </div>
  );
}

/** Links from the provenance block to the case, fork and scenario the skill was extracted from. */
export function ProvenanceLinks({ content }: { content: SkillContent }) {
  const styles = useInsightStyles();
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
            Decision fork
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
