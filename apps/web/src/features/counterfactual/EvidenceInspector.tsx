'use client';

import type { CounterfactualScenario, CounterfactualStep, Evidence } from '@caseguard/schemas';
import { ACTION_KIND_LABELS, MODEL_ESTIMATE_NOTICE } from '@caseguard/schemas';
import {
  Button,
  KeyValueList,
  Notice,
  Panel,
  ProvenanceBadge,
  StatusBadge,
  cg,
  formatDateTimeUtc,
  formatDuration,
  formatNumber,
  formatProbability,
} from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { AsOfLimited, isRateLimited } from '../../components/case/as-of';
import type { ApiError } from '../../lib/api/errors';
import { EvidenceItem } from '../reasoning/EvidenceItem';
import { EFFORT_LABELS, EXECUTOR_LABELS, LEVEL_LABELS } from '../reasoning/labels';
import { TruncatedText } from '../reasoning/TruncatedText';
import { addMinutes } from '../reasoning/time';

const useStyles = makeStyles({
  grid: {
    display: 'grid',
    gap: cg.space[4],
    gridTemplateColumns: 'minmax(0, 1fr)',
    alignItems: 'start',
    '@media (min-width: 1000px)': { gridTemplateColumns: 'minmax(220px, 1fr) minmax(0, 2.4fr)' },
  },
  steps: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  stepButton: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    width: '100%',
    boxSizing: 'border-box',
    textAlign: 'start',
    padding: `${cg.space[3]} ${cg.space[4]}`,
    borderRadius: cg.radius.md,
    border: `1px dashed ${cg.tone.simulated.border}`,
    backgroundColor: cg.surfaceSunken,
    color: cg.text,
    font: 'inherit',
    cursor: 'pointer',
    minHeight: '44px',
    transitionProperty: 'background-color, border-color, box-shadow',
    transitionDuration: cg.motion.fast,
    transitionTimingFunction: cg.motion.easing,
    ':hover': { backgroundColor: cg.tone.simulated.tint },
    ':focus-visible': { outline: `2px solid ${cg.focus}`, outlineOffset: '2px' },
  },
  stepSelected: {
    border: `1px solid ${cg.tone.simulated.solid}`,
    backgroundColor: cg.tone.simulated.tint,
    boxShadow: `0 14px 36px -18px ${cg.glow}`,
  },
  stepTitle: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    overflowWrap: 'anywhere',
  },
  stepMeta: { fontSize: tokens.fontSizeBase200, color: cg.textSecondary },
  detail: { display: 'flex', flexDirection: 'column', gap: cg.space[3], minWidth: 0 },
  section: { display: 'flex', flexDirection: 'column', gap: cg.space[2], minWidth: 0 },
  h3: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
  },
  h4: { margin: 0, fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold },
  text: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
    overflowWrap: 'anywhere',
  },
  muted: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  badges: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  bullets: {
    margin: 0,
    paddingLeft: cg.space[4],
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase300,
  },
  chips: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: cg.space[2],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  outcome: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    padding: cg.space[3],
    borderRadius: cg.radius.md,
    border: `1px dashed ${cg.tone.simulated.border}`,
    backgroundColor: cg.tone.simulated.tint,
  },
});

export interface Bearing {
  hypothesisName: string;
  polarity: 'supports' | 'contradicts';
}

/** How the decision-time evidence read is going (it is an earlier view, so the server may refuse it for a while). */
export interface EvidenceReadState {
  loading: boolean;
  error: ApiError | null;
  /** When the error happened: a new failure restarts the countdown. */
  errorAt: number;
  retrying: boolean;
  onRetry: () => void;
}

export interface EvidenceInspectorProps {
  caseId: string;
  scenario: CounterfactualScenario;
  selectedStepId: string | null;
  onSelectStep: (stepId: string) => void;
  /** Evidence on record at the decision instant, by id (null while it loads). */
  evidenceById: ReadonlyMap<string, Evidence> | null;
  /** Which hypotheses each piece of evidence bears on, at the decision instant. */
  bearings: ReadonlyMap<string, readonly Bearing[]>;
  evidenceRead: EvidenceReadState;
}

function StepDetail({
  step,
  index,
  total,
  scenario,
  caseId,
  evidenceById,
  bearings,
  evidenceRead,
  onSelectStep,
}: {
  step: CounterfactualStep;
  index: number;
  total: number;
} & Omit<EvidenceInspectorProps, 'selectedStepId'>) {
  const styles = useStyles();
  const cited = step.evidenceUsedIds.map((id) => ({ id, item: evidenceById?.get(id) }));
  const found = cited.flatMap(({ item }) => (item ? [item] : []));
  const priorSteps = step.priorStepIds.flatMap((id) => {
    const prior = scenario.steps.find((s) => s.id === id);
    return prior ? [prior] : [];
  });

  return (
    <div
      className={styles.detail}
      role="region"
      aria-label={`Step ${index + 1} of ${total}: ${step.label}`}
    >
      <div className={styles.badges}>
        <h3 className={styles.h3}>
          Step {index + 1}: {step.label}
        </h3>
        <ProvenanceBadge kind="simulated" />
        <StatusBadge
          status={step.safe ? 'productive' : 'unsupported'}
          label={step.safe ? 'Safe' : 'Not safe'}
          size="small"
        />
        <StatusBadge
          status={step.supported ? 'productive' : 'unsupported'}
          label={step.supported ? 'Defined in the knowledge pack' : 'Unsupported'}
          size="small"
        />
      </div>
      <p className={styles.muted}>
        {ACTION_KIND_LABELS[step.kind]} · carried out by {EXECUTOR_LABELS[step.executor]} · expected{' '}
        {formatDuration(step.offsetMinutes.mid)} after the decision (range{' '}
        {formatDuration(step.offsetMinutes.low)} to {formatDuration(step.offsetMinutes.high)}),
        around {formatDateTimeUtc(addMinutes(scenario.boundary.asOf, step.offsetMinutes.mid))}{' '}
        (simulated)
      </p>

      <section className={styles.section} aria-label="Why this step">
        <h4 className={styles.h4}>Why the simulation chose it</h4>
        <p className={styles.text}>
          <TruncatedText text={step.rationale} limit={320} />
        </p>
      </section>

      <section className={styles.section} aria-label="Evidence behind this step">
        <h4 className={styles.h4}>Evidence behind this step ({step.evidenceUsedIds.length})</h4>
        <p className={styles.muted}>
          Only evidence on record before the decision instant can appear here (
          {formatDateTimeUtc(scenario.boundary.asOf)}).
        </p>
        {step.evidenceUsedIds.length === 0 ? (
          <p className={styles.text}>
            This step cites no case evidence. It follows from the knowledge pack and from the
            simulated results of earlier steps
            {priorSteps.length > 0 ? ` (${priorSteps.map((s) => s.label).join('; ')})` : ''}.
          </p>
        ) : evidenceRead.loading ? (
          <p className={styles.text}>Loading the evidence record…</p>
        ) : found.length > 0 ? (
          <ul className={styles.list} aria-label="Evidence cited by this step">
            {found.map((item) => {
              const bears = bearings.get(item.id) ?? [];
              return (
                <EvidenceItem
                  key={item.id}
                  evidence={item}
                  caseId={caseId}
                  note={
                    bears.length > 0
                      ? `Bears on: ${bears.map((b) => `${b.hypothesisName} (${b.polarity === 'supports' ? 'supports' : 'contradicts'})`).join('; ')}`
                      : undefined
                  }
                />
              );
            })}
          </ul>
        ) : evidenceRead.error && isRateLimited(evidenceRead.error) ? (
          <AsOfLimited
            key={evidenceRead.errorAt}
            error={evidenceRead.error}
            subject="the evidence on record at the decision"
            compact
            onRetry={evidenceRead.onRetry}
            retrying={evidenceRead.retrying}
          />
        ) : (
          <Notice
            variant="warning"
            compact
            title={evidenceRead.error ? 'Evidence unavailable' : 'Not in the record'}
          >
            {evidenceRead.error
              ? 'The evidence record could not be loaded, so the cited items cannot be shown. Retry the page to load them.'
              : `The step cites ${step.evidenceUsedIds.length} evidence item${step.evidenceUsedIds.length === 1 ? '' : 's'} that the decision-time record does not contain: ${cited.map((c) => c.id).join(', ')}.`}
          </Notice>
        )}
        {priorSteps.length > 0 ? (
          <div className={styles.section}>
            <h4 className={styles.h4}>Builds on earlier simulated steps</h4>
            <ul className={styles.chips}>
              {priorSteps.map((prior) => (
                <li key={prior.id}>
                  <Button size="sm" variant="secondary" onClick={() => onSelectStep(prior.id)}>
                    Step {prior.index + 1}: {prior.label}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section className={styles.section} aria-label="Predicted outcome">
        <h4 className={styles.h4}>Predicted outcome</h4>
        <div className={styles.outcome}>
          <span className={styles.text}>
            <strong>{step.predictedOutcome.label}</strong> (
            {formatProbability(step.predictedOutcome.probability)}, estimate)
          </span>
          <span className={styles.text}>{step.predictedOutcome.simulatedResult}</span>
          {step.predictedOutcome.alternatives.length > 0 ? (
            <span className={styles.muted}>
              Other possible results:{' '}
              {step.predictedOutcome.alternatives
                .map((a) => `${a.label} (${formatProbability(a.probability)})`)
                .join('; ')}
            </span>
          ) : null}
        </div>
        <p className={styles.muted}>
          Expected information from this step:{' '}
          {formatNumber(step.expectedInformationGainBits, { maximumFractionDigits: 2 })} bits
          (estimate). Uncertainty: {LEVEL_LABELS[step.uncertainty]}.
        </p>
      </section>

      <section className={styles.section} aria-label="Confidence after this step">
        <h4 className={styles.h4}>Simulated confidence after this step</h4>
        <KeyValueList
          columns={2}
          items={step.posteriorAfter.map((p) => ({
            id: p.hypothesisId,
            label: p.name,
            value: `${formatProbability(p.confidence)} (simulated)`,
          }))}
        />
        <p className={styles.muted}>{MODEL_ESTIMATE_NOTICE}</p>
      </section>

      <section className={styles.section} aria-label="Safety and cost">
        <h4 className={styles.h4}>Safety and cost</h4>
        <KeyValueList
          columns={3}
          items={[
            { label: 'Customer effort', value: EFFORT_LABELS[step.customerEffort] },
            {
              label: 'Operational risk',
              value: `${formatNumber(step.operationalRisk, { maximumFractionDigits: 2 })} of 1`,
            },
            {
              label: 'Tokens',
              value: `≈ ${formatNumber(step.tokenEstimate, { maximumFractionDigits: 0 })}`,
            },
          ]}
        />
        {step.safetyNotes.length > 0 ? (
          <ul className={styles.bullets}>
            {step.safetyNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}
        {!step.supported && step.unsupportedReasons.length > 0 ? (
          <Notice variant="warning" compact title="Unsupported">
            {step.unsupportedReasons.join(' ')}
          </Notice>
        ) : null}
      </section>

      {step.assumptions.length > 0 ? (
        <section className={styles.section} aria-label="Assumptions of this step">
          <h4 className={styles.h4}>Assumptions</h4>
          <ul className={styles.bullets}>
            {step.assumptions.map((assumption) => (
              <li key={assumption}>{assumption}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/**
 * The evidence inspector: pick a simulated step and see exactly which evidence on record at the decision moment
 * supports it, what the model expects the step to find and what it assumes. Nothing later than the decision appears.
 */
export function EvidenceInspector(props: EvidenceInspectorProps) {
  const styles = useStyles();
  const { scenario, selectedStepId, onSelectStep } = props;
  const steps = scenario.steps;
  const selectedIndex = Math.max(
    0,
    steps.findIndex((s) => s.id === selectedStepId),
  );
  const selected = steps[selectedIndex];

  return (
    <Panel
      title="Evidence inspector"
      level={3}
      description="Choose a simulated step to see exactly what it rests on."
      help="Each simulated step lists the evidence it relies on, quoted from the case and bounded by the decision instant. Where a step cites no case evidence it follows from earlier simulated results, and the inspector says so."
      accent="simulated"
    >
      {steps.length === 0 || !selected ? (
        <p className={styles.text}>This path has no steps.</p>
      ) : (
        <div className={styles.grid}>
          <ol className={styles.steps} aria-label="Simulated steps">
            {steps.map((step, index) => {
              const active = index === selectedIndex;
              return (
                <li key={step.id}>
                  <button
                    type="button"
                    className={mergeClasses(styles.stepButton, active && styles.stepSelected)}
                    aria-pressed={active}
                    onClick={() => onSelectStep(step.id)}
                  >
                    <span className={styles.stepTitle}>
                      {index + 1}. {step.label}
                    </span>
                    <span className={styles.stepMeta}>
                      Simulated · {step.evidenceUsedIds.length}{' '}
                      {step.evidenceUsedIds.length === 1 ? 'evidence item' : 'evidence items'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          <StepDetail step={selected} index={selectedIndex} total={steps.length} {...props} />
        </div>
      )}
    </Panel>
  );
}
