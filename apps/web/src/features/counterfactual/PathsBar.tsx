'use client';

import type {
  CounterfactualScenario,
  CounterfactualStrategy,
  DecisionFork,
  Job,
} from '@caseguard/schemas';
import { COUNTERFACTUAL_STRATEGIES, STRATEGY_LABELS } from '@caseguard/schemas';
import {
  Button,
  ConfirmDialog,
  Notice,
  SegmentedControl,
  StatusBadge,
  cg,
  useRestoreFocusTarget,
} from '@caseguard/ui';
import { Checkbox, makeStyles, tokens, useId } from '@fluentui/react-components';
import { FlaskConicalIcon } from 'lucide-react';
import { useState } from 'react';
import { JobProgress } from '../../components/common/JobProgress';
import { useApiMutation } from '../../lib/api/hooks';
import { GatedAction } from '../../lib/auth/session';
import { useToast } from '../../lib/toast';
import { explainJobStartFailure } from '../reasoning/errors';
import { useInvalidate } from '../reasoning/hooks';
import { REVIEW_STATE_BADGES } from '../reasoning/labels';
import { strategiesConverge } from './model';

const useStyles = makeStyles({
  strategies: { display: 'flex', flexDirection: 'column', gap: cg.space[1] },
  groupLabel: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
  },
  picker: {
    display: 'flex',
    flex: '1 1 360px',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: cg.space[2],
    minWidth: 0,
  },
  // Three long names do not fit a phone in a row: they stack, one choice per line, instead of hiding behind a scroll.
  segments: {
    '@media (max-width: 639px)': { display: 'flex', flexDirection: 'column', width: '100%' },
  },
  option: { display: 'inline-flex', alignItems: 'center', gap: cg.space[2] },
  hint: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
});

const STRATEGY_HINT: Record<CounterfactualStrategy, string> = {
  balanced: 'Weighs information, time, tokens, customer effort and risk together.',
  lowest_customer_effort: 'Avoids heavy customer asks; excludes high-effort actions.',
  fastest_diagnosis: 'Puts more weight on time to diagnosis.',
};

/** Generating the simulated paths of a key decision: who may, which strategies, and the job that does it. */
export interface PathGeneration {
  fork: DecisionFork | null;
  /** Strategies this key decision has no simulated path for yet. */
  missing: readonly CounterfactualStrategy[];
  have: ReadonlySet<CounterfactualStrategy>;
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Opens the dialog with every missing strategy chosen. */
  begin: () => void;
  chosen: readonly CounterfactualStrategy[];
  toggle: (strategy: CounterfactualStrategy, checked: boolean) => void;
  /** Starts the job. It rejects with a plain-language reason, for the dialog to show. */
  confirm: () => Promise<void>;
  /** The job being followed, once one was started. */
  jobId: string | null;
}

/**
 * The state of generating paths, kept above the screen so that the primary action in the page header and the secondary
 * one next to the strategies open the same dialog, and the job's progress stays on screen while another decision is chosen.
 */
export function usePathGeneration(
  caseId: string,
  fork: DecisionFork | null,
  scenarios: readonly CounterfactualScenario[],
): PathGeneration {
  const have = new Set(scenarios.map((scenario) => scenario.strategy));
  const missing = COUNTERFACTUAL_STRATEGIES.filter((strategy) => !have.has(strategy));
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<readonly CounterfactualStrategy[]>(missing);
  const [jobId, setJobId] = useState<string | null>(null);
  const run = useApiMutation('counterfactuals.run');

  return {
    fork,
    missing,
    have,
    open,
    setOpen,
    begin: () => {
      setChosen(missing);
      setOpen(true);
    },
    chosen,
    toggle: (strategy, checked) =>
      setChosen((current) =>
        checked ? [...new Set([...current, strategy])] : current.filter((s) => s !== strategy),
      ),
    confirm: async () => {
      if (!fork) return;
      if (chosen.length === 0) throw new Error('Choose at least one strategy.');
      try {
        const result = await run.mutateAsync({
          params: { caseId, forkId: fork.id },
          body: { strategies: [...chosen] },
        });
        setJobId(result.job.id);
      } catch (error) {
        throw new Error(explainJobStartFailure(error, 'simulation'), { cause: error });
      }
    },
    jobId,
  };
}

export interface GeneratePathsButtonProps {
  generation: PathGeneration;
  /** The key decision already has paths: the action adds strategies and is secondary. Without paths it is the primary action. */
  hasPaths: boolean;
}

/**
 * Generates the missing paths. Without paths it is the screen's one primary action; with some, it adds the strategies that
 * are missing. Disabled, with the reason, for a role that may not run simulations; disabled for a key decision that cannot
 * be simulated.
 */
export function GeneratePathsButton({ generation, hasPaths }: GeneratePathsButtonProps) {
  const restoreFocus = useRestoreFocusTarget();
  const { fork, missing } = generation;
  if (!fork || missing.length === 0) return null;
  return (
    <GatedAction permission="counterfactual:run">
      <Button
        variant={hasPaths ? 'secondary' : 'primary'}
        size={hasPaths ? 'sm' : 'md'}
        icon={<FlaskConicalIcon />}
        disabled={!fork.eligibility.eligible}
        onClick={generation.begin}
        {...restoreFocus}
      >
        {hasPaths ? 'Generate more strategies' : 'Generate paths'}
      </Button>
    </GatedAction>
  );
}

/** The confirmation behind "Generate paths": which strategies, and what a simulation is and is not. */
export function GeneratePathsDialog({ generation }: { generation: PathGeneration }) {
  const styles = useStyles();
  const strategiesLabelId = useId('strategies');
  return (
    <ConfirmDialog
      open={generation.open}
      onOpenChange={generation.setOpen}
      title="Generate paths"
      confirmLabel="Generate"
      onConfirm={generation.confirm}
    >
      <p>
        Each strategy simulates the same decision moment with a different priority, using only what
        was known then. Nothing is executed: the paths are estimates, and strategies may choose the
        same steps.
      </p>
      <div role="group" aria-labelledby={strategiesLabelId} className={styles.strategies}>
        <span id={strategiesLabelId} className={styles.groupLabel}>
          Strategies
        </span>
        {COUNTERFACTUAL_STRATEGIES.map((strategy) => (
          <Checkbox
            key={strategy}
            checked={generation.chosen.includes(strategy)}
            onChange={(_event, data) => generation.toggle(strategy, data.checked === true)}
            label={`${STRATEGY_LABELS[strategy]}${generation.have.has(strategy) ? ' (already generated)' : ''}`}
          />
        ))}
      </div>
    </ConfirmDialog>
  );
}

/** The real stages of the generation job, while it runs and after it ends. */
export function GenerationProgress({ generation }: { generation: PathGeneration }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  if (!generation.jobId) return null;
  return (
    <JobProgress
      jobId={generation.jobId}
      title="Generating simulated paths"
      level={2}
      onTerminal={(job: Job) => {
        if (job.status === 'succeeded') {
          toast.success('Simulated paths are ready', {
            body: 'They are estimates made from what was known at the decision moment.',
          });
          void invalidate(['counterfactuals.list', 'graph.get']);
          return;
        }
        if (job.status === 'cancelled') {
          toast.info('Path generation was cancelled', {
            body: 'No further paths will be generated. Generate them again when you are ready.',
          });
          return;
        }
        toast.error('The paths could not be generated', {
          body: job.error?.message ?? 'The job stopped before it completed.',
        });
      }}
    />
  );
}

export interface StrategyPickerProps {
  /** The simulated paths of this key decision, in strategy order. */
  scenarios: readonly CounterfactualScenario[];
  selectedId: string | null;
  onSelect: (scenarioId: string) => void;
}

/**
 * One choice per strategy that has a path, with the review state of each as an icon (its word is the accessible name), and
 * a line on what the chosen strategy puts first. Choosing one changes every number below.
 */
export function StrategyPicker({ scenarios, selectedId, onSelect }: StrategyPickerProps) {
  const styles = useStyles();
  const value = selectedId ?? scenarios[0]?.id ?? '';
  const chosen = scenarios.find((scenario) => scenario.id === value);
  return (
    <div className={styles.picker}>
      <SegmentedControl
        aria-label="Simulated path strategies"
        className={styles.segments}
        value={value}
        onValueChange={onSelect}
        options={scenarios.map((scenario) => {
          const state = REVIEW_STATE_BADGES[scenario.reviewState];
          return {
            value: scenario.id,
            label: (
              <span className={styles.option}>
                {STRATEGY_LABELS[scenario.strategy]}
                <StatusBadge status={state.status} label={state.label} size="small" iconOnly />
              </span>
            ),
          };
        })}
      />
      {chosen ? <p className={styles.hint}>{STRATEGY_HINT[chosen.strategy]}</p> : null}
      {strategiesConverge(scenarios) ? (
        <p className={styles.hint}>
          All {scenarios.length} strategies chose the same steps for this key decision. That can
          happen when one path clearly dominates; they differ only in their estimated timings.
        </p>
      ) : null}
    </div>
  );
}

/** Why a key decision cannot be simulated, when that is the reason it has no paths. */
export function EligibilityNotice({ fork, hasPaths }: { fork: DecisionFork; hasPaths: boolean }) {
  if (fork.eligibility.eligible || hasPaths) return null;
  return (
    <Notice variant="warning" compact title="Not eligible">
      This key decision cannot be simulated:{' '}
      {fork.eligibility.reasons.join(' ') || 'an eligibility check failed.'}
    </Notice>
  );
}
