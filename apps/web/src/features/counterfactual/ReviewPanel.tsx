'use client';

import type { CounterfactualScenario } from '@caseguard/schemas';
import {
  ConfirmDialog,
  Notice,
  Panel,
  StatusBadge,
  cg,
  formatDateTimeUtc,
  useRestoreFocusTarget,
} from '@caseguard/ui';
import { Button, makeStyles, tokens } from '@fluentui/react-components';
import {
  CheckmarkCircleRegular,
  DismissCircleRegular,
  MoleculeRegular,
} from '@fluentui/react-icons';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { JobProgress } from '../../components/common/JobProgress';
import { isApiError } from '../../lib/api/errors';
import { useApiMutation } from '../../lib/api/hooks';
import { GatedAction, useSession } from '../../lib/auth/session';
import { useToast } from '../../lib/toast';
import { explainJobStartFailure, explainReviewFailure } from '../reasoning/errors';
import { useActorLabel, useInvalidate } from '../reasoning/hooks';
import { REVIEW_STATE_BADGES, isAcceptedState } from '../reasoning/labels';
import { acceptanceBlockers } from './model';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[3], minWidth: 0 },
  section: { display: 'flex', flexDirection: 'column', gap: cg.space[2], minWidth: 0 },
  h3: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
  },
  text: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
    overflowWrap: 'anywhere',
  },
  muted: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  decision: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    padding: `${cg.space[2]} ${cg.space[3]}`,
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surfaceSunken,
  },
  bullets: {
    margin: 0,
    paddingLeft: cg.space[4],
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase300,
  },
});

type Decision = 'accept' | 'reject';

function ReviewButtons({
  caseId,
  scenario,
  blockers,
}: {
  caseId: string;
  scenario: CounterfactualScenario;
  blockers: readonly string[];
}) {
  const styles = useStyles();
  const toast = useToast();
  const invalidate = useInvalidate();
  const restoreFocus = useRestoreFocusTarget();
  const [open, setOpen] = useState<Decision | null>(null);
  const review = useApiMutation('counterfactuals.review');

  const submit = async (decision: Decision, reason: string): Promise<void> => {
    try {
      await review.mutateAsync({
        params: { caseId, scenarioId: scenario.id },
        body: { decision, reason, expectedVersion: scenario.version },
      });
    } catch (error) {
      // A stale version or a refused acceptance means the path changed: show the newest state either way.
      await invalidate(['counterfactuals.list', 'graph.get']);
      throw new Error(explainReviewFailure(error), { cause: error });
    }
    await invalidate(['counterfactuals.list', 'graph.get']);
    toast.success(decision === 'accept' ? 'Path accepted' : 'Path rejected', {
      body:
        decision === 'accept'
          ? 'It is recorded with your reason. A skill can now be extracted from it.'
          : 'The reason is recorded and audited.',
    });
  };

  const pending = scenario.reviewState === 'pending';
  const accepted = isAcceptedState(scenario.reviewState);
  const acceptDisabledReason = blockers.length > 0 ? blockers.join(' ') : null;

  return (
    <div className={styles.row}>
      {accepted ? null : (
        <GatedAction permission="counterfactual:review">
          <Button
            appearance="primary"
            icon={<CheckmarkCircleRegular />}
            disabled={acceptDisabledReason !== null}
            onClick={() => setOpen('accept')}
            {...restoreFocus}
          >
            {pending ? 'Accept this path' : 'Accept instead'}
          </Button>
        </GatedAction>
      )}
      {scenario.reviewState === 'rejected' ? null : (
        <GatedAction permission="counterfactual:review">
          <Button
            appearance="outline"
            icon={<DismissCircleRegular />}
            onClick={() => setOpen('reject')}
            {...restoreFocus}
          >
            {pending ? 'Reject this path' : 'Reject instead'}
          </Button>
        </GatedAction>
      )}
      <ConfirmDialog
        open={open === 'accept'}
        onOpenChange={(next) => setOpen(next ? 'accept' : null)}
        title="Accept this simulated path?"
        confirmLabel="Accept path"
        reason={{
          label: 'Why is this path realistic?',
          placeholder: 'For example: every step uses only what was known before the decision.',
          minLength: 5,
          maxLength: 1000,
        }}
        onConfirm={(reason) => submit('accept', reason)}
      >
        <p>
          Accepting says the path is realistic and used only what was known at the decision moment.
          Your name, role and reason are recorded in the audit log. A skill can then be extracted
          from it; approving that skill still needs a different person.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={open === 'reject'}
        onOpenChange={(next) => setOpen(next ? 'reject' : null)}
        title="Reject this simulated path?"
        confirmLabel="Reject path"
        tone="danger"
        reason={{
          label: 'Why is this path unrealistic?',
          placeholder: 'For example: step 3 assumes access the engineer did not have.',
          minLength: 5,
          maxLength: 1000,
        }}
        onConfirm={(reason) => submit('reject', reason)}
      >
        <p>
          Rejecting keeps the path on record but removes it from consideration for skills. Your
          name, role and reason are recorded in the audit log.
        </p>
      </ConfirmDialog>
    </div>
  );
}

function ExtractSkill({ caseId, scenario }: { caseId: string; scenario: CounterfactualScenario }) {
  const styles = useStyles();
  const router = useRouter();
  const toast = useToast();
  const restoreFocus = useRestoreFocusTarget();
  const extract = useApiMutation('skills.extract');
  const { can, isLoading } = useSession();
  const [jobId, setJobId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const accepted = isAcceptedState(scenario.reviewState);

  const start = async (): Promise<void> => {
    setFailure(null);
    try {
      const result = await extract.mutateAsync({
        params: { caseId },
        body: { scenarioId: scenario.id },
      });
      setJobId(result.job.id);
    } catch (error) {
      setFailure(
        isApiError(error) && error.issues.length > 0
          ? `${error.message} ${error.issues.map((issue) => issue.message).join(' ')}`
          : explainJobStartFailure(error, 'extraction'),
      );
    }
  };

  return (
    <section className={styles.section} aria-label="Extract SkillDNA">
      <h3 className={styles.h3}>SkillDNA</h3>
      <p className={styles.text}>
        A reviewer-accepted path can be distilled into a draft SkillDNA: a reusable, governed
        investigation step sequence. It starts as a draft, and nothing is published automatically.
      </p>
      {!accepted ? (
        <Notice variant="info" compact title="Accept the path first">
          Only a path a reviewer has accepted can seed a skill.
        </Notice>
      ) : null}
      <div className={styles.row}>
        <GatedAction permission="skill:extract">
          <Button
            appearance="primary"
            icon={<MoleculeRegular />}
            disabled={!accepted || extract.isPending || jobId !== null}
            onClick={() => void start()}
            {...restoreFocus}
          >
            Extract SkillDNA
          </Button>
        </GatedAction>
      </div>
      {accepted && !isLoading && !can('skill:extract') ? (
        <p className={styles.muted}>
          Your role cannot extract skills. An engineer or a skill curator can do it from this page.
        </p>
      ) : null}
      {failure ? (
        <Notice variant="warning" title="The skill could not be extracted">
          {failure}
        </Notice>
      ) : null}
      {jobId ? (
        <JobProgress
          jobId={jobId}
          title="Extracting SkillDNA"
          level={3}
          onTerminal={(job) => {
            if (job.status === 'succeeded') {
              const skillId = job.resultRef?.type === 'skill' ? job.resultRef.id : null;
              toast.success('Draft SkillDNA created', {
                body: skillId ? 'Opening the new skill.' : 'It is in the SkillDNA library.',
              });
              router.push(skillId ? `/skills/${encodeURIComponent(skillId)}` : '/skills');
              return;
            }
            setJobId(null);
            setFailure(
              job.status === 'cancelled'
                ? 'The extraction was cancelled before it finished, so no skill was created.'
                : (job.error?.message ?? 'The job stopped before it completed.'),
            );
          }}
        />
      ) : null}
    </section>
  );
}

export interface ReviewPanelProps {
  caseId: string;
  scenario: CounterfactualScenario;
}

/**
 * The reviewer's decision on a simulated path (accept or reject, each with a required reason and an optimistic version
 * check) and, for an accepted path, the gated action that extracts a draft SkillDNA with real job progress.
 */
export function ReviewPanel({ caseId, scenario }: ReviewPanelProps) {
  const styles = useStyles();
  const actorLabel = useActorLabel();
  const state = REVIEW_STATE_BADGES[scenario.reviewState];
  const blockers = acceptanceBlockers(scenario);

  return (
    <Panel
      title="Review and SkillDNA"
      level={3}
      description="A person decides whether the simulated path is realistic. Only an accepted path can seed a skill."
      help="Reviewers accept or reject a simulated path with a reason. The decision is recorded with the reviewer's identity and is audited. A path that failed the leak or validity checks can be rejected but never accepted. Accepting does not publish anything: a skill extracted from an accepted path is a draft that still needs separate validation and a different approver."
      accent="brand"
    >
      <div className={styles.stack}>
        <section className={styles.section} aria-label="Reviewer decision">
          <h3 className={styles.h3}>Reviewer decision</h3>
          <div className={styles.row}>
            <StatusBadge status={state.status} label={state.label} />
            <span className={styles.muted}>Version {scenario.version}</span>
          </div>
          {scenario.reviewState !== 'pending' ? (
            <div className={styles.decision}>
              <span className={styles.text}>
                <strong>{state.label}</strong>
                {scenario.reviewedBy ? ` by ${actorLabel(scenario.reviewedBy)}` : ''}
                {scenario.reviewedAt ? ` on ${formatDateTimeUtc(scenario.reviewedAt)}` : ''}
              </span>
              {scenario.reviewReason ? (
                <span className={styles.text}>“{scenario.reviewReason}”</span>
              ) : null}
            </div>
          ) : (
            <>
              <p className={styles.text}>
                {scenario.version > 1
                  ? 'No decision applies to this version of the path yet.'
                  : 'Nobody has reviewed this path yet.'}
              </p>
              {scenario.version > 1 ? (
                <Notice variant="info" compact title="Pending again because the analysis changed">
                  This path was regenerated when the analysis changed (it is now version{' '}
                  {scenario.version}). A decision stays on a path only when the regenerated
                  simulation is identical, so any earlier decision on it no longer applies and the
                  path needs a new review. If there was one, the reset is recorded in the audit log.
                </Notice>
              ) : null}
            </>
          )}
          {blockers.length > 0 ? (
            <Notice variant="warning" compact title="Cannot be accepted">
              <ul className={styles.bullets}>
                {blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
              It can still be rejected, with a reason.
            </Notice>
          ) : null}
          <Notice variant="info" compact title="Two sets of eyes">
            Your decision is recorded with your name, role and reason. The person who approves a
            skill extracted from an accepted path must be someone else.
          </Notice>
          <ReviewButtons caseId={caseId} scenario={scenario} blockers={blockers} />
        </section>
        <ExtractSkill caseId={caseId} scenario={scenario} />
      </div>
    </Panel>
  );
}
