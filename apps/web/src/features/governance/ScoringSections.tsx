'use client';

import {
  ActionValueConfigSchema,
  EFFORT_LEVELS,
  PENALTY_KEYS,
  PENALTY_LABELS,
  QUALITY_DIMENSIONS,
  QUALITY_DIMENSION_LABELS,
  QualityConfigSchema,
  type GovernanceSettings,
} from '@caseguard/schemas';
import { cg, formatNumber } from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { FieldGrid, FieldGroup, GroupError, NumberField, TextField, useEditor } from './fields';
import { getIn } from './messages';
import { SectionEditor } from './SectionEditor';

const useStyles = makeStyles({
  sum: { margin: 0, fontSize: tokens.fontSizeBase300, color: cg.textSecondary },
});

/** "The weights add up to 1.00" for a group of weights, because the API does not force them to. */
function WeightSum({ paths, subject }: { paths: readonly string[]; subject: string }) {
  const styles = useStyles();
  const { draft } = useEditor();
  const total = paths.reduce((sum, path) => {
    const value = getIn(draft, path);
    return sum + (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  }, 0);
  return (
    <p className={styles.sum} role="status">
      The {subject} add up to{' '}
      {formatNumber(total, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}. They are
      normally set to add up to 1.
    </p>
  );
}

const EFFORT_LABELS: Record<(typeof EFFORT_LEVELS)[number], string> = {
  none: 'No effort',
  low: 'Low effort',
  medium: 'Medium effort',
  high: 'High effort',
  very_high: 'Very high effort',
};

const bandsMustDescend = (
  value: GovernanceSettings['quality']['value'],
): Record<string, string> => {
  const { strong, adequate, needsAttention } = value.bands;
  return strong > adequate && adequate > needsAttention
    ? {}
    : { bands: 'Bands must descend: strong > adequate > needsAttention.' };
};

const QUALITY_WEIGHT_PATHS = QUALITY_DIMENSIONS.map((key) => `weights.${key}`);
const ACTION_WEIGHT_PATHS = ['time', 'token', 'customer', 'risk'].map((key) => `weights.${key}`);

/** Quality scoring (`quality` section): dimension weights, penalty points and the score bands. */
export function QualitySection({ envelope }: { envelope: GovernanceSettings['quality'] }) {
  return (
    <SectionEditor
      section="quality"
      envelope={envelope}
      schema={QualityConfigSchema}
      title="Quality scoring"
      description="How the Case Quality Index is composed from its dimensions, penalties and bands."
      help="The Case Quality Index scores how well an investigation was run, from six weighted dimensions minus penalty points for specific process problems. It scores cases and processes, never people. Bands turn the score into a plain label."
      effect="enforced"
      effectNote="Used when a case is analysed. Results already stored are not recalculated; analyse the case again to apply a change."
      extraErrors={bandsMustDescend}
    >
      <FieldGroup title="Version">
        <FieldGrid columns={2}>
          <TextField
            path="version"
            label="Version label"
            maxLength={40}
            hint="Free text, shown with scores."
          />
        </FieldGrid>
      </FieldGroup>
      <FieldGroup
        title="Dimension weights"
        description="How much each dimension counts towards the composite, from 0 to 1."
      >
        <FieldGrid>
          {QUALITY_DIMENSIONS.map((key) => (
            <NumberField
              key={key}
              path={`weights.${key}`}
              label={QUALITY_DIMENSION_LABELS[key]}
              min={0}
              max={1}
              step={0.05}
            />
          ))}
        </FieldGrid>
        <WeightSum paths={QUALITY_WEIGHT_PATHS} subject="dimension weights" />
      </FieldGroup>
      <FieldGroup
        title="Penalty points"
        description="Points deducted for each kind of process problem, from 0 to 30."
      >
        <FieldGrid>
          {PENALTY_KEYS.map((key) => (
            <NumberField
              key={key}
              path={`penaltyPoints.${key}`}
              label={PENALTY_LABELS[key]}
              min={0}
              max={30}
              step={1}
              unit="pts"
            />
          ))}
          <NumberField
            path="penaltyCap"
            label="Penalty cap"
            min={0}
            max={100}
            unit="pts"
            hint="The most that can be deducted in total."
          />
        </FieldGrid>
      </FieldGroup>
      <FieldGroup
        title="Score bands"
        description="Lower bounds, from 0 to 100. They must descend: strong, then adequate, then needs attention."
      >
        <FieldGrid>
          <NumberField path="bands.strong" label="Strong from" min={0} max={100} />
          <NumberField path="bands.adequate" label="Adequate from" min={0} max={100} />
          <NumberField path="bands.needsAttention" label="Needs attention from" min={0} max={100} />
        </FieldGrid>
        <GroupError path="bands" />
      </FieldGroup>
    </SectionEditor>
  );
}

/** Action-value configuration (`action_value` section): how the next best diagnostic action is ranked. */
export function ActionValueSection({ envelope }: { envelope: GovernanceSettings['action_value'] }) {
  return (
    <SectionEditor
      section="action_value"
      envelope={envelope}
      schema={ActionValueConfigSchema}
      title="Action-value configuration"
      description="How diagnostic actions are ranked: expected information against time, tokens, customer effort and risk."
      help="An action's value is the information it is expected to give, divided by what it costs the investigation. The weights say how much each cost counts; the risk ceiling blocks actions that are too risky however valuable they look. Reviewers can override a ranking with a reason."
      effect="enforced"
      effectNote="Used when a case is analysed. Results already stored are not recalculated; analyse the case again to apply a change."
    >
      <FieldGroup title="Version">
        <FieldGrid columns={2}>
          <TextField
            path="version"
            label="Version label"
            maxLength={40}
            hint="Free text, shown with rankings."
          />
        </FieldGrid>
      </FieldGroup>
      <FieldGroup
        title="Cost weights"
        description="How much each kind of cost counts, from 0 to 1."
      >
        <FieldGrid>
          <NumberField path="weights.time" label="Time" min={0} max={1} step={0.05} />
          <NumberField path="weights.token" label="Tokens" min={0} max={1} step={0.05} />
          <NumberField
            path="weights.customer"
            label="Customer effort"
            min={0}
            max={1}
            step={0.05}
          />
          <NumberField path="weights.risk" label="Operational risk" min={0} max={1} step={0.05} />
        </FieldGrid>
        <WeightSum paths={ACTION_WEIGHT_PATHS} subject="cost weights" />
      </FieldGroup>
      <FieldGroup
        title="Normalisation"
        description="The values that count as the maximum, so different costs can be compared."
      >
        <FieldGrid>
          <NumberField path="normalization.maxTimeMinutes" label="Max time" unit="min" min={1} />
          <NumberField path="normalization.maxTokens" label="Max tokens" min={1} />
          <NumberField
            path="normalization.maxInformationBits"
            label="Max information"
            unit="bits"
            min={0.1}
            step={0.1}
          />
        </FieldGrid>
      </FieldGroup>
      <FieldGroup
        title="Customer effort scale"
        description="How heavy each effort level counts, from 0 to 1."
      >
        <FieldGrid>
          {EFFORT_LEVELS.map((level) => (
            <NumberField
              key={level}
              path={`effortScale.${level}`}
              label={EFFORT_LABELS[level]}
              min={0}
              max={1}
              step={0.05}
            />
          ))}
        </FieldGrid>
      </FieldGroup>
      <FieldGroup title="Safety and sensitivity">
        <FieldGrid>
          <NumberField
            path="epsilon"
            label="Cost floor (epsilon)"
            min={0.001}
            max={1}
            step={0.01}
            hint="Stops near-free actions scoring without limit."
          />
          <NumberField
            path="riskCeiling"
            label="Risk ceiling"
            min={0}
            max={1}
            step={0.05}
            hint="Actions at or above this risk are never recommended."
          />
          <NumberField
            path="sensitivityDelta"
            label="Sensitivity change"
            min={0.05}
            max={0.5}
            step={0.05}
            hint="How far each weight is nudged to show how stable a ranking is."
          />
        </FieldGrid>
      </FieldGroup>
    </SectionEditor>
  );
}
