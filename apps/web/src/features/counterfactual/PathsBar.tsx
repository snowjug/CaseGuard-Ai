'use client';

import type {
  CounterfactualScenario,
  CounterfactualStrategy,
  DecisionFork,
} from '@caseguard/schemas';
import { COUNTERFACTUAL_STRATEGIES, STRATEGY_LABELS } from '@caseguard/schemas';
import { ConfirmDialog, Notice, StatusBadge, cg, useRestoreFocusTarget } from '@caseguard/ui';
import {
  Button,
  Checkbox,
  Tab,
  TabList,
  makeStyles,
  tokens,
  useId,
} from '@fluentui/react-components';
import { BeakerRegular } from '@fluentui/react-icons';
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
  root: { display: 'flex', flexDirection: 'column', gap: cg.space[2], minWidth: 0 },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[3] },
  tabs: { flex: '1 1 320px', minWidth: 0, flexWrap: 'wrap' },
  tabLabel: { display: 'inline-flex', alignItems: 'center', gap: cg.space[2] },
  text: { margin: 0, fontSize: tokens.fontSizeBase300, color: cg.textSecondary },
  muted: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  strategies: { display: 'flex', flexDirection: 'column', gap: cg.space[1] },
  groupLabel: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
  },
});

const STRATEGY_HINT: Record<CounterfactualStrategy, string> = {
  balanced: 'Weighs information, time, tokens, customer effort and risk together.',
  lowest_customer_effort: 'Avoids heavy customer asks; excludes high-effort actions.',
  fastest_diagnosis: 'Puts more weight on time to diagnosis.',
};

export interface PathsBarProps {
  caseId: string;
  fork: DecisionFork;
  /** The scenarios of this fork, in strategy order. */
  scenarios: readonly CounterfactualScenario[];
  selectedId: string | null;
  onSelect: (scenarioId: string) => void;
}

/**
 * The simulated paths generated for the fork (one tab per strategy, with its review state) and, for people who may run
 * simulations, a gated action that generates the missing strategies and shows the job's real progress.
 */
export function PathsBar({ caseId, fork, scenarios, selectedId, onSelect }: PathsBarProps) {
  const styles = useStyles();
  const toast = useToast();
  const invalidate = useInvalidate();
  const have = new Set(scenarios.map((s) => s.strategy));
  const missing = COUNTERFACTUAL_STRATEGIES.filter((strategy) => !have.has(strategy));
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<readonly CounterfactualStrategy[]>(missing);
  const [jobId, setJobId] = useState<string | null>(null);
  const run = useApiMutation('counterfactuals.run');
  const converge = strategiesConverge(scenarios);
  const restoreFocus = useRestoreFocusTarget();
  const strategiesLabelId = useId('strategies');

  const toggle = (strategy: CounterfactualStrategy, checked: boolean): void =>
    setChosen((current) =>
      checked ? [...new Set([...current, strategy])] : current.filter((s) => s !== strategy),
    );

  return (
    <div className={styles.root}>
      <div className={styles.row}>
        {scenarios.length > 0 ? (
          <TabList
            className={styles.tabs}
            selectedValue={selectedId ?? scenarios[0]?.id ?? ''}
            onTabSelect={(_event, data) => onSelect(String(data.value))}
            aria-label="Simulated path strategies"
          >
            {scenarios.map((scenario) => {
              const state = REVIEW_STATE_BADGES[scenario.reviewState];
              return (
                <Tab key={scenario.id} value={scenario.id}>
                  <span className={styles.tabLabel}>
                    {STRATEGY_LABELS[scenario.strategy]}
                    <StatusBadge status={state.status} label={state.label} size="small" />
                  </span>
                </Tab>
              );
            })}
          </TabList>
        ) : (
          <p className={styles.text}>No simulated paths have been generated for this fork yet.</p>
        )}
        {missing.length > 0 ? (
          <>
            <GatedAction permission="counterfactual:run">
              <Button
                appearance={scenarios.length === 0 ? 'primary' : 'outline'}
                icon={<BeakerRegular />}
                disabled={!fork.eligibility.eligible}
                onClick={() => {
                  setChosen(missing);
                  setOpen(true);
                }}
                {...restoreFocus}
              >
                {scenarios.length === 0 ? 'Generate simulated paths' : 'Generate more strategies'}
              </Button>
            </GatedAction>
            <ConfirmDialog
              open={open}
              onOpenChange={setOpen}
              title="Generate simulated paths"
              confirmLabel="Generate"
              onConfirm={async () => {
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
              }}
            >
              <p>
                Each strategy simulates the same decision moment with a different priority, using
                only what was known then. Nothing is executed: the paths are estimates, and
                strategies may choose the same steps.
              </p>
              <div role="group" aria-labelledby={strategiesLabelId} className={styles.strategies}>
                <span id={strategiesLabelId} className={styles.groupLabel}>
                  Strategies
                </span>
                {COUNTERFACTUAL_STRATEGIES.map((strategy) => (
                  <Checkbox
                    key={strategy}
                    checked={chosen.includes(strategy)}
                    onChange={(_event, data) => toggle(strategy, data.checked === true)}
                    label={`${STRATEGY_LABELS[strategy]}${have.has(strategy) ? ' (already generated)' : ''}`}
                  />
                ))}
              </div>
            </ConfirmDialog>
          </>
        ) : null}
      </div>
      {!fork.eligibility.eligible && scenarios.length === 0 ? (
        <Notice variant="warning" compact title="Not eligible">
          This fork cannot be simulated:{' '}
          {fork.eligibility.reasons.join(' ') || 'an eligibility check failed.'}
        </Notice>
      ) : null}
      {converge ? (
        <p className={styles.muted}>
          All {scenarios.length} strategies chose the same steps for this fork. That can happen when
          one path clearly dominates; they differ only in their estimated timings.
        </p>
      ) : null}
      {selectedId ? (
        <p className={styles.muted}>
          {STRATEGY_HINT[scenarios.find((s) => s.id === selectedId)?.strategy ?? 'balanced']}
        </p>
      ) : null}
      {jobId ? (
        <JobProgress
          jobId={jobId}
          title="Generating simulated paths"
          level={3}
          onTerminal={(job) => {
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
      ) : null}
    </div>
  );
}
