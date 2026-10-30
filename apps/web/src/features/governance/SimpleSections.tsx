'use client';

import {
  ExportControlsSchema,
  FeatureFlagsSchema,
  RetentionConfigSchema,
  type GovernanceSettings,
} from '@caseguard/schemas';
import { FieldGrid, FieldGroup, NumberField, SwitchField, TextField } from './fields';
import { SectionEditor } from './SectionEditor';

/** Retention (`retention` section): how long each kind of data is meant to be kept. Recorded only today. */
export function RetentionSection({ envelope }: { envelope: GovernanceSettings['retention'] }) {
  return (
    <SectionEditor
      section="retention"
      envelope={envelope}
      schema={RetentionConfigSchema}
      title="Retention"
      description="How long each kind of data is meant to be kept."
      help="Retention periods say how long case data, the audit trail, model executions and analytics are kept. A legal hold suspends deletion. The audit trail has a minimum of 30 days."
      effect="recorded"
      effectNote="These periods are stored and audited, but no scheduled job enforces them yet: nothing is deleted when a period passes."
    >
      <FieldGroup title="Retention periods">
        <FieldGrid>
          <TextField path="version" label="Version label" maxLength={40} hint="Free text." />
          <NumberField
            path="caseDataDays"
            label="Case data"
            unit="days"
            min={1}
            max={3650}
            hint="Recorded only: nothing deletes case data when this period ends."
          />
          <NumberField
            path="auditDays"
            label="Audit trail"
            unit="days"
            min={30}
            max={3650}
            hint="Recorded only: nothing deletes audit events when this period ends."
          />
          <NumberField
            path="modelExecutionDays"
            label="Model executions"
            unit="days"
            min={1}
            max={3650}
            hint="Recorded only: nothing deletes model execution records when this period ends."
          />
          <NumberField
            path="analyticsDays"
            label="Analytics"
            unit="days"
            min={1}
            max={3650}
            hint="Recorded only: nothing deletes analytics when this period ends."
          />
        </FieldGrid>
        <SwitchField
          path="legalHold"
          label="Legal hold"
          hint="Recorded only: nothing is deleted today, so a legal hold suspends nothing."
        />
      </FieldGroup>
    </SectionEditor>
  );
}

const FLAGS = [
  [
    'presentationMode',
    'Presentation mode',
    'Recorded only: this flag does not switch presentation mode on or off.',
  ],
  [
    'counterfactualLab',
    'Counterfactual Lab',
    'Recorded only: this flag does not make the Counterfactual Lab available or hide it.',
  ],
  [
    'skillMutation',
    'SkillDNA mutation proposals',
    'Recorded only: this flag does not allow or block refinement proposals for published skills.',
  ],
  [
    'azureOpenAiProvider',
    'Azure OpenAI provider',
    "Recorded only: this flag does not allow or block the Azure OpenAI provider; the deployment's configuration decides.",
  ],
  [
    'semanticCache',
    'Semantic cache',
    'Recorded only: this flag does not turn the semantic cache on or off.',
  ],
  [
    'portfolioDemoData',
    'Portfolio demo data',
    'Recorded only: this flag does not load or remove the larger synthetic portfolio.',
  ],
] as const;

/** Feature flags (`feature_flags` section). Recorded only: nothing reads them, and the session's features come from the deployment. */
export function FlagsSection({ envelope }: { envelope: GovernanceSettings['feature_flags'] }) {
  return (
    <SectionEditor
      section="feature_flags"
      envelope={envelope}
      schema={FeatureFlagsSchema}
      title="Feature flags"
      description="Switches for optional capabilities."
      help="Feature flags are meant to turn optional capabilities on or off per tenant. Today the values are stored and audited, but the application does not read them: the features your session reports come from the deployment's own configuration."
      effect="recorded"
      effectNote="No part of the application reads these flags yet, and the features reported to your session come from the deployment's configuration, not from this section. Changing a flag is recorded but does not turn anything on or off."
    >
      <FieldGroup title="Capabilities">
        <FieldGrid>
          {FLAGS.map(([key, label, hint]) => (
            <SwitchField key={key} path={key} label={label} hint={hint} />
          ))}
        </FieldGrid>
      </FieldGroup>
    </SectionEditor>
  );
}

/** Data-export controls (`export_controls` section): whether and how much data may leave the system. */
export function ExportControlsSection({
  envelope,
}: {
  envelope: GovernanceSettings['export_controls'];
}) {
  return (
    <SectionEditor
      section="export_controls"
      envelope={envelope}
      schema={ExportControlsSchema}
      title="Export controls"
      description="Whether case data and the audit log may be exported, and how much at a time."
      help="Exports are guarded: they need the export permission and a reason, are limited to a maximum number of records (an export above it is refused, never cut short), and are written to the audit trail before any data is returned."
      effect="enforced"
      effectNote="Enforced on every export: whether case and audit exports are allowed, and the record cap. The allowed formats and the reason requirement are recorded only: JSON is the only format, and a reason is always required."
    >
      <FieldGroup title="What may be exported">
        <FieldGrid>
          <SwitchField path="allowCaseExport" label="Allow case export" />
          <SwitchField path="allowAuditExport" label="Allow audit-log export" />
          <SwitchField
            path="requireReasonForExport"
            label="Require a reason"
            hint="Recorded only: the API always requires a reason."
          />
        </FieldGrid>
        <FieldGrid columns={2}>
          <NumberField
            path="maxRecordsPerExport"
            label="Most records per export"
            min={1}
            max={100000}
            hint="A larger export is refused, not truncated."
          />
          <TextField path="version" label="Version label" maxLength={40} hint="Free text." />
        </FieldGrid>
      </FieldGroup>
    </SectionEditor>
  );
}
