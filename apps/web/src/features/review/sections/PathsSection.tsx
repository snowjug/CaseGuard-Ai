'use client';

import {
  COUNTERFACTUAL_STRATEGIES,
  type CounterfactualScenario,
  type DecisionFork,
} from '@caseguard/schemas';
import {
  ConfirmDialog,
  EmptyState,
  Notice,
  PathComparison,
  ProvenanceBadge,
  ScrollRegion,
  StatusBadge,
  cg,
  formatDateTimeUtc,
  useRestoreFocusTarget,
} from '@caseguard/ui';
import { Button, makeStyles, tokens } from '@fluentui/react-components';
import { BeakerRegular, CheckmarkCircleRegular } from '@fluentui/react-icons';
import { useMemo, useState } from 'react';
import { JobProgress } from '../../../components/common/JobProgress';
import { LinkButton } from '../../../components/common/LinkButton';
import { useApiMutation } from '../../../lib/api/hooks';
import { GatedAction, useSession } from '../../../lib/auth/session';
import { caseHref } from '../../../lib/deep-links';
import { useToast } from '../../../lib/toast';
import { comparisonTracks, metricDeltas } from '../../counterfactual/model';
import { TrustPanel } from '../../counterfactual/TrustPanel';
import { explainJobStartFailure } from '../../reasoning/errors';
import { useActorLabel, useInvalidate } from '../../reasoning/hooks';
import {
  useActionsHandle,
  useDetailHandle,
  useForksHandle,
  useRunHandle,
  useScenariosHandle,
} from '../hooks';
import { earliestFork } from '../model/forks';
import { methodNotes } from '../model/method';
import { SIMULATED_LABEL, derivePaths, type PathModel, type PathsView } from '../model/paths';
import { PartState, SectionFrame, useRoleText } from './shared';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  text: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
    overflowWrap: 'anywhere',
  },
  meta: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  strong: { color: cg.text, fontWeight: tokens.fontWeightSemibold },
  badges: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: tokens.fontSizeBase300,
    color: cg.text,
  },
  caption: {
    textAlign: 'left',
    padding: `0 0 ${cg.space[2]}`,
    fontWeight: tokens.fontWeightSemibold,
  },
  th: {
    textAlign: 'left',
    padding: cg.space[2],
    borderBottom: `2px solid ${cg.borderControl}`,
    fontWeight: tokens.fontWeightSemibold,
    verticalAlign: 'bottom',
  },
  td: { padding: cg.space[2], borderBottom: `1px solid ${cg.borderSubtle}`, verticalAlign: 'top' },
  sim: { backgroundColor: cg.tone.simulated.tint },
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    minWidth: 0,
    padding: cg.space[3],
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surfaceSunken,
  },
  details: { fontSize: tokens.fontSizeBase300, color: cg.textSecondary },
  summary: {
    cursor: 'pointer',
    color: cg.textLink,
    fontWeight: tokens.fontWeightSemibold,
    minHeight: '24px',
  },
  bullets: {
    margin: `${cg.space[2]} 0 0`,
    paddingLeft: cg.space[4],
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
  },
  actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  checks: { display: 'flex', flexDirection: 'column', gap: cg.space[1] },
});

const CONFIDENCE_BADGE = { high: 'productive', medium: 'uncertain', low: 'uncertain' } as const;

function StepByStep({
  caseId,
  fork,
  scenario,
}: {
  caseId: string;
  fork: DecisionFork;
  scenario: CounterfactualScenario;
}) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const actions = useActionsHandle(caseId, open);
  const tracks =
    actions.source.kind === 'ready' ? comparisonTracks(fork, scenario, actions.source.data) : null;
  return (
    <details className={styles.details} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className={styles.summary}>Compare the two paths step by step</summary>
      {open ? (
        tracks ? (
          <PathComparison
            actual={tracks.actual}
            counterfactual={tracks.counterfactual}
            forkStepId={tracks.forkStepId}
            forkLabel={fork.title}
            metrics={metricDeltas(scenario)}
            title="The recorded path compared with the simulated alternative"
          />
        ) : (
          <PartState handle={actions} what="the recorded steps" />
        )
      ) : null}
    </details>
  );
}

function PathView({
  caseId,
  path,
  fork,
  scenario,
}: {
  caseId: string;
  path: PathModel;
  fork: DecisionFork | null;
  scenario: CounterfactualScenario | null;
}) {
  const styles = useStyles();
  const actor = useActorLabel();
  return (
    <div className={styles.stack}>
      <Notice variant="model-estimate" compact title="Simulated estimate">
        {SIMULATED_LABEL}. It replays{' '}
        {path.decision ? `decision point ${path.decision.number}` : 'the decision'} with steps from
        the knowledge pack, using only what was known then.
      </Notice>
      {path.usable ? null : (
        <Notice variant="warning" compact title="This path is not reliable">
          <ul className={styles.bullets}>
            {path.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Notice>
      )}
      <p className={styles.text}>
        <span className={styles.strong}>{path.strategyLabel}</span>
        {path.decision
          ? ` at decision point ${path.decision.number}: ${path.decision.title}`
          : ''}. {path.headline}
      </p>
      <ScrollRegion label="Recorded path compared with the better-supported path, scrollable">
        <table className={styles.table}>
          <caption className={styles.caption}>
            The recorded path and the better-supported path (simulated estimate)
          </caption>
          <thead>
            <tr>
              <th scope="col" className={styles.th}>
                Measure
              </th>
              <th scope="col" className={styles.th}>
                Recorded
              </th>
              <th scope="col" className={`${styles.th} ${styles.sim}`}>
                Better-supported path (simulated estimate)
              </th>
              <th scope="col" className={styles.th}>
                Reading
              </th>
            </tr>
          </thead>
          <tbody>
            {path.rows.map((row) => (
              <tr key={row.key}>
                <th scope="row" className={styles.td}>
                  {row.label}
                </th>
                <td className={styles.td}>{row.recordedText}</td>
                <td className={`${styles.td} ${styles.sim}`}>{row.simulatedText}</td>
                <td className={styles.td}>{row.directionLabel}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
      <div className={styles.panel}>
        <div className={styles.badges}>
          <StatusBadge
            status={CONFIDENCE_BADGE[path.confidence.level]}
            label={`${path.confidence.label} (${path.confidence.scoreText})`}
          />
          <StatusBadge
            status={path.validity.valid ? 'productive' : 'unsupported'}
            label={
              path.validity.valid
                ? `All ${path.validity.total} validity checks passed`
                : `${path.validity.passed} of ${path.validity.total} validity checks passed`
            }
          />
          <StatusBadge
            status={path.validity.leakCheckPassed ? 'productive' : 'unsupported'}
            label={
              path.validity.leakCheckPassed
                ? 'Used only what was known then'
                : 'Failed the "only what was known then" check'
            }
          />
        </div>
        <p className={styles.text}>{path.confidence.rationale}</p>
        <p className={styles.meta}>
          Confidence says how consistent the {path.rollouts.count} simulated runs were; the
          diagnosis was reached in {path.rollouts.diagnosisReachedText} of them.
        </p>
      </div>
      {path.trust ? <TrustPanel trust={path.trust} /> : null}
      <div className={styles.panel}>
        <div className={styles.badges}>
          <StatusBadge status={path.review.badge} label={path.review.label} />
        </div>
        <p className={styles.text}>
          {path.review.state === 'pending'
            ? 'A reviewer has not decided whether this path is realistic.'
            : `${path.review.label}${path.review.by ? ` by ${actor(path.review.by)}` : ''}${path.review.at ? ` on ${formatDateTimeUtc(path.review.at)}` : ''}${path.review.reason ? `: “${path.review.reason}”` : '.'}`}
        </p>
      </div>
      <details className={styles.details}>
        <summary className={styles.summary}>Assumptions ({path.assumptions.length})</summary>
        <ul className={styles.bullets}>
          {path.assumptions.map((assumption) => (
            <li key={assumption}>{assumption}</li>
          ))}
        </ul>
      </details>
      <details className={styles.details}>
        <summary className={styles.summary}>The simulated steps ({path.steps.length})</summary>
        <ol className={styles.bullets}>
          {path.steps.map((step) => (
            <li key={step.index}>
              <span className={styles.strong}>{step.label}</span> — {step.ownerLabel},{' '}
              {step.effortLabel.toLowerCase()} customer effort, done about {step.timing} after the
              decision. Expected result: {step.outcome}
              {step.supported ? '' : ' (not supported by the knowledge pack)'}
            </li>
          ))}
        </ol>
      </details>
      {fork && scenario ? <StepByStep caseId={caseId} fork={fork} scenario={scenario} /> : null}
      {path.others.length > 0 ? (
        <p className={styles.meta}>
          Other strategies simulated for this decision point:{' '}
          {path.others
            .map((other) => `${other.label} (${other.reviewLabel.toLowerCase()})`)
            .join(', ')}
          . Compare them in the Counterfactual Lab.
        </p>
      ) : null}
      <div className={styles.actions}>
        <LinkButton
          href={`${caseHref(caseId, 'counterfactual')}?sel=${encodeURIComponent(path.scenarioId)}`}
          appearance="outline"
          icon={<BeakerRegular />}
        >
          Open in the Counterfactual Lab
        </LinkButton>
      </div>
    </div>
  );
}

function Simulate({
  caseId,
  decision,
  eligible,
  reasons,
}: {
  caseId: string;
  decision: { forkId: string; number: number; title: string };
  eligible: boolean;
  reasons: readonly string[];
}) {
  const styles = useStyles();
  const toast = useToast();
  const invalidate = useInvalidate();
  const role = useRoleText();
  const { can, isLoading } = useSession();
  const run = useApiMutation('counterfactuals.run');
  const restoreFocus = useRestoreFocusTarget();
  const [open, setOpen] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const allowed = can('counterfactual:run');
  return (
    <div className={styles.stack}>
      <EmptyState
        compact
        icon={<BeakerRegular />}
        title="No better-supported path has been simulated yet"
        description={`Nobody has simulated what a better-supported path would have looked like at decision point ${decision.number}: ${decision.title}. A simulation replays that moment using only what was known then, and is always an estimate.`}
        action={
          <GatedAction permission="counterfactual:run">
            <Button
              appearance="primary"
              icon={<BeakerRegular />}
              disabled={!eligible || jobId !== null}
              onClick={() => setOpen(true)}
              {...restoreFocus}
            >
              Simulate a better-supported path
            </Button>
          </GatedAction>
        }
      />
      {!isLoading && !allowed ? (
        <p className={styles.meta}>
          Your role ({role}) cannot simulate paths. Engineers and administrators can run it from
          this page.
        </p>
      ) : null}
      {!eligible ? (
        <Notice variant="warning" compact title="Not eligible">
          This decision point cannot be simulated:{' '}
          {reasons.join(' ') || 'an eligibility check failed.'}
        </Notice>
      ) : null}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Simulate a better-supported path"
        confirmLabel="Simulate"
        onConfirm={async () => {
          try {
            const result = await run.mutateAsync({
              params: { caseId, forkId: decision.forkId },
              body: { strategies: [...COUNTERFACTUAL_STRATEGIES] },
            });
            setJobId(result.job.id);
          } catch (error) {
            throw new Error(explainJobStartFailure(error, 'simulation'), { cause: error });
          }
        }}
      >
        <p>
          This simulates three strategies for the same decision moment, using only what was known
          then. Nothing is executed: the paths are estimates, and a reviewer decides whether they
          are realistic.
        </p>
      </ConfirmDialog>
      {jobId ? (
        <JobProgress
          jobId={jobId}
          title="Simulating better-supported paths"
          level={3}
          onTerminal={(job) => {
            if (job.status === 'succeeded') {
              toast.success('Simulated paths are ready', {
                body: 'They are estimates made from what was known at the decision moment.',
              });
              void invalidate(['counterfactuals.list', 'graph.get']);
              return;
            }
            setJobId(null);
            if (job.status === 'cancelled') {
              toast.info('The simulation was cancelled', {
                body: 'Nothing was added to the case.',
              });
              return;
            }
            toast.error('The paths could not be simulated', {
              body: job.error?.message ?? 'The job stopped before it completed.',
            });
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * What should have happened: the recorded path set beside the better-supported path the analysis simulated for the
 * earliest important decision point, with the engine's own ranges, its confidence, its checks and its assumptions, and
 * always labelled a simulated estimate. When nothing has been simulated it says so and offers the existing action (with its
 * job progress), or explains who can run it.
 */
export function PathsSection({ caseId }: { caseId: string }) {
  const forks = useForksHandle(caseId);
  const scenarios = useScenariosHandle(caseId);
  const run = useRunHandle(caseId);
  const detail = useDetailHandle(caseId);
  const forksData = forks.source.kind === 'ready' ? forks.source.data : null;
  const scenarioData = scenarios.source.kind === 'ready' ? scenarios.source.data : null;
  const view: PathsView | null = useMemo(
    () => (forksData && scenarioData ? derivePaths(forksData, scenarioData) : null),
    [forksData, scenarioData],
  );
  const fork = forksData ? earliestFork(forksData) : null;
  const scenario =
    view?.kind === 'ready'
      ? (scenarioData?.find((item) => item.id === view.path.scenarioId) ?? null)
      : null;
  const notes = methodNotes('paths', {
    run: run.source.kind === 'ready' ? run.source.data : null,
    quality: null,
    coaching: null,
    detail: detail.source.kind === 'ready' ? detail.source.data : null,
    path: view?.kind === 'ready' ? view.path : null,
  });
  const blocked = [forks, scenarios].find((handle) => handle.source.kind !== 'ready');
  return (
    <SectionFrame
      id="should-have"
      title="What should have happened"
      description="The recorded path beside a better-supported path, as a simulated estimate."
      badges={
        <>
          <ProvenanceBadge kind="simulated" />
          <ProvenanceBadge kind="estimated" />
        </>
      }
      method={notes}
    >
      {blocked ? (
        <PartState handle={blocked} what="the simulated paths" />
      ) : !view ? null : view.kind === 'no-decision-points' ? (
        <EmptyState
          compact
          icon={<CheckmarkCircleRegular />}
          title="Nothing to compare"
          description="No decision point stood out, so there was no better-supported path to simulate. That is a good sign for this case, not an error."
        />
      ) : view.kind === 'not-simulated' ? (
        <Simulate
          caseId={caseId}
          decision={view.decision}
          eligible={view.eligible}
          reasons={view.reasons}
        />
      ) : (
        <PathView caseId={caseId} path={view.path} fork={fork} scenario={scenario} />
      )}
    </SectionFrame>
  );
}
