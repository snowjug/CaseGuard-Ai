'use client';

import {
  AGENT_LABELS,
  AGENT_NAMES,
  ModelConfigSchema,
  type AgentName,
  type GovernanceSettings,
} from '@caseguard/schemas';
import { Accordion, Button, HelpButton, IconButton, ProvenanceBadge, cg } from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { ResponsiveTable, type ResponsiveColumn } from '../../lib/advanced-view-parts';
import { PROVIDER_LABELS } from '../../lib/labels';
import { FieldGroup, NumberField, SelectField, SwitchField, TextField, useEditor } from './fields';
import { getIn } from './messages';
import { SectionEditor } from './SectionEditor';

const useStyles = makeStyles({
  provider: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: cg.space[2],
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
  },
  providerEnd: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: cg.space[1],
    whiteSpace: 'nowrap',
  },
  nowrap: { whiteSpace: 'nowrap' },
  rules: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    margin: 0,
    padding: 0,
    listStyleType: 'none',
  },
  rule: {
    display: 'grid',
    gap: cg.space[3],
    alignItems: 'end',
    gridTemplateColumns: 'minmax(0, 1fr)',
    '@media (min-width: 640px)': {
      gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2fr) auto',
    },
  },
  muted: { margin: 0, fontSize: tokens.fontSizeBase300, color: cg.textSecondary },
  add: { paddingTop: cg.space[3] },
});

const BUDGET_COLUMNS = [
  { key: 'maxInputTokens', label: 'Max input tokens' },
  { key: 'maxOutputTokens', label: 'Max output tokens' },
  { key: 'maxRetries', label: 'Max retries' },
  { key: 'timeoutMs', label: 'Timeout (ms)' },
] as const;

function AgentBudgets() {
  const columns: ResponsiveColumn<AgentName>[] = [
    {
      id: 'agent',
      header: 'Analysis step',
      rowHeader: true,
      width: '208px',
      cell: (agent) => AGENT_LABELS[agent],
    },
    ...BUDGET_COLUMNS.map((column): ResponsiveColumn<AgentName> => ({
      id: column.key,
      header: column.label,
      cell: (agent) => (
        <NumberField
          hideLabel
          path={`agentBudgets.${agent}.${column.key}`}
          label={`${AGENT_LABELS[agent]}: ${column.label}`}
          step={1}
        />
      ),
    })),
  ];
  return (
    <ResponsiveTable
      caption="Per-agent budgets"
      columns={columns}
      rows={AGENT_NAMES}
      getRowId={(agent) => agent}
      minWidth={760}
      dense
    />
  );
}

const MAX_RULES = 20;

function RoutingRules() {
  const styles = useStyles();
  const { draft, set, disabled } = useEditor();
  const rules = getIn(draft, 'routing.rules');
  const list = Array.isArray(rules) ? (rules as readonly unknown[]) : [];
  const options = AGENT_NAMES.map((agent) => ({ value: agent, label: AGENT_LABELS[agent] }));
  return (
    <div>
      <p className={styles.muted}>
        Rules send one analysis step to a named model instead of the default. {list.length} of{' '}
        {MAX_RULES} rules used.
      </p>
      {list.length > 0 ? (
        <ul className={styles.rules} aria-label="Model routing rules">
          {list.map((_rule, index) => (
            <li key={index} className={styles.rule}>
              <SelectField
                stacked
                path={`routing.rules.${index}.agent`}
                label="Analysis step"
                options={options}
              />
              <TextField
                stacked
                path={`routing.rules.${index}.model`}
                label="Model"
                maxLength={120}
              />
              <IconButton
                icon={<Trash2Icon />}
                label={`Remove routing rule ${index + 1}`}
                disabled={disabled}
                onClick={() =>
                  set(
                    'routing.rules',
                    list.filter((_item, position) => position !== index),
                  )
                }
              />
            </li>
          ))}
        </ul>
      ) : null}
      <div className={styles.add}>
        <Button
          variant="secondary"
          icon={<PlusIcon />}
          disabled={disabled || list.length >= MAX_RULES}
          onClick={() => set('routing.rules', [...list, { agent: AGENT_NAMES[0], model: '' }])}
        >
          Add a routing rule
        </Button>
      </div>
    </div>
  );
}

function ProviderNote({
  provider,
}: {
  provider: GovernanceSettings['model']['value']['provider'];
}) {
  const styles = useStyles();
  return (
    <p className={styles.provider}>
      <span>
        The provider in use is chosen by the deployment, not by this section:{' '}
        {PROVIDER_LABELS[provider]} is recorded here.
      </span>
      <span className={styles.providerEnd}>
        {provider === 'deterministic' ? <ProvenanceBadge kind="simulated" /> : null}
        <HelpButton label="About the provider" title="Provider">
          Limits you set are tightened to what the deployment allows, so a tenant can spend less
          than the operator&apos;s caps and never more. System status shows what actually runs.
        </HelpButton>
      </span>
    </p>
  );
}

const HELP =
  'These settings govern every model call: how much text may be sent, how long to wait, how often to retry, what to do when a provider keeps failing and what each analysis step may spend. Empty cost fields mean no limit or price is configured, so cost is shown as unknown instead of invented.';

/** Model configuration (`model` section): token, retry and timeout limits, cost controls, per-agent budgets and routing. */
export function ModelSection({ envelope }: { envelope: GovernanceSettings['model'] }) {
  const styles = useStyles();
  return (
    <SectionEditor
      section="model"
      envelope={envelope}
      schema={ModelConfigSchema}
      title="Model configuration"
      description="Limits, budgets and routing for the AI analysis steps."
      help={HELP}
      effect="enforced"
      effectNote="Read by the AI layer and by cost estimates: changes apply to the next model call. The deployment's own limits always win."
    >
      <ProviderNote provider={envelope.value.provider} />
      <Accordion>
        <FieldGroup
          title="Limits for every model call"
          defaultOpen
          paths={[
            'version',
            'maxInputTokens',
            'maxOutputTokens',
            'timeoutMs',
            'maxRetries',
            'maxAnalysisDepth',
            'temperature',
          ]}
        >
          <TextField
            path="version"
            label="Version label"
            maxLength={40}
            hint="Free text, shown with results."
          />
          <NumberField path="maxInputTokens" label="Max input tokens" min={256} max={200000} />
          <NumberField path="maxOutputTokens" label="Max output tokens" min={64} max={32000} />
          <NumberField path="timeoutMs" label="Timeout" unit="ms" min={1000} max={300000} />
          <NumberField path="maxRetries" label="Max retries" min={0} max={5} />
          <NumberField
            path="maxAnalysisDepth"
            label="Max analysis depth"
            min={1}
            max={12}
            hint="Counterfactual steps and refinement passes."
          />
          <NumberField
            path="temperature"
            label="Temperature"
            min={0}
            max={1}
            step={0.1}
            hint="0 keeps answers as repeatable as possible."
          />
        </FieldGroup>
        <FieldGroup
          title="Cost controls"
          description="Leave a box empty for none. With no unit prices set, cost is shown as unknown, never as zero."
          paths={['costLimits', 'unitPrices']}
        >
          <NumberField
            nullable
            path="costLimits.perRequestUsd"
            label="Per request (USD)"
            min={0}
            placeholder="No limit set"
          />
          <NumberField
            nullable
            path="costLimits.perCaseUsd"
            label="Per case (USD)"
            min={0}
            placeholder="No limit set"
          />
          <NumberField
            nullable
            path="costLimits.perDayUsd"
            label="Per day (USD)"
            min={0}
            placeholder="No limit set"
          />
          <NumberField
            nullable
            path="unitPrices.inputPer1kUsd"
            label="Input price per 1,000 tokens (USD)"
            min={0}
            step={0.001}
            placeholder="Not configured"
          />
          <NumberField
            nullable
            path="unitPrices.outputPer1kUsd"
            label="Output price per 1,000 tokens (USD)"
            min={0}
            step={0.001}
            placeholder="Not configured"
          />
          <NumberField
            nullable
            path="unitPrices.cachedInputPer1kUsd"
            label="Cached input price per 1,000 tokens (USD)"
            min={0}
            step={0.001}
            placeholder="Not configured"
          />
        </FieldGroup>
        <FieldGroup
          title="Reliability and caching"
          description={
            <>
              The safety limit stops calling a provider that keeps failing; the semantic cache
              reuses answers to near-identical{' '}
              <span className={styles.nowrap}>
                requests.{' '}
                <HelpButton label="About the safety limit" title="Safety limit">
                  Technically this is a circuit breaker: after the set number of failures in a row
                  it stops calls to the provider until the reset time has passed.
                </HelpButton>
              </span>
            </>
          }
          paths={['circuitBreaker', 'semanticCache']}
        >
          <NumberField
            path="circuitBreaker.failureThreshold"
            label="Failures before the safety limit trips"
            min={1}
            max={50}
          />
          <NumberField
            path="circuitBreaker.resetMs"
            label="Safety limit reset"
            unit="ms"
            min={1000}
            max={600000}
          />
          <SwitchField path="semanticCache.enabled" label="Semantic cache on" />
          <NumberField
            path="semanticCache.similarityThreshold"
            label="Cache similarity threshold"
            min={0.5}
            max={1}
            step={0.01}
          />
          <NumberField
            path="semanticCache.ttlSeconds"
            label="Cache lifetime"
            unit="s"
            min={10}
            max={86400}
          />
        </FieldGroup>
        <FieldGroup
          title="Azure OpenAI settings"
          description="Used only when the Azure OpenAI provider is connected by the deployment, which sets its own deployment name and API version."
          paths={['azureDeployment', 'azureApiVersion']}
        >
          <TextField path="azureDeployment" label="Deployment name" maxLength={120} />
          <TextField path="azureApiVersion" label="API version" maxLength={40} />
        </FieldGroup>
        <FieldGroup
          title="Per-agent budgets"
          description="What each analysis step may use. They are capped by the limits above and by the deployment."
          paths={['agentBudgets']}
        >
          <AgentBudgets />
        </FieldGroup>
        <FieldGroup title="Model routing" paths={['routing']}>
          <TextField path="routing.defaultModel" label="Default model" maxLength={120} />
          <TextField
            nullable
            path="routing.cheapModel"
            label="Cheaper model"
            maxLength={120}
            hint="Optional; empty means none."
          />
          <RoutingRules />
        </FieldGroup>
      </Accordion>
    </SectionEditor>
  );
}
