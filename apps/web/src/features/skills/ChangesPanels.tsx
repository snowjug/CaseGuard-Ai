'use client';

import {
  SKILL_LIFECYCLE_LABELS,
  type SkillDetail,
  type SkillValidation,
  type SkillVersion,
} from '@caseguard/schemas';
import { Notice, Panel, StatusBadge, formatDateTimeUtc } from '@caseguard/ui';
import { Button, Field, Select } from '@fluentui/react-components';
import { useMemo, useState } from 'react';
import { JobProgress } from '../../components/common/JobProgress';
import { useApiMutation } from '../../lib/api/hooks';
import { useToast } from '../../lib/toast';
import { useActorLabel, useCurrentUserId } from '../quality/actors';
import { ClampedText } from '../quality/ClampedText';
import { explainFailure, failureText, needsReload } from '../quality/failure';
import { GatedConfirm } from '../quality/GatedConfirm';
import { useInsightStyles } from '../quality/styles';
import { SKILL_INVALIDATES, useAnalysedCases, useRefreshSkills } from './hooks';
import { VALIDATION_KIND_LABELS, VALIDATION_OUTCOMES, isWithdrawn } from './labels';

/** The newest validation of a kind for one version, or undefined. */
export function latestFor(
  validations: readonly SkillValidation[],
  versionId: string,
  kind: SkillValidation['kind'],
): SkillValidation | undefined {
  return [...validations]
    .filter((validation) => validation.versionId === versionId && validation.kind === kind)
    .sort((a, b) => (a.executedAt < b.executedAt ? 1 : -1))[0];
}

function GateLine({
  validation,
  kind,
}: {
  validation: SkillValidation | undefined;
  kind: SkillValidation['kind'];
}) {
  const styles = useInsightStyles();
  if (!validation) {
    return (
      <li>
        {VALIDATION_KIND_LABELS[kind]}:{' '}
        <StatusBadge status="missing" label="Not run" size="small" />
      </li>
    );
  }
  const outcome = VALIDATION_OUTCOMES[validation.outcome];
  return (
    <li>
      {VALIDATION_KIND_LABELS[kind]}:{' '}
      <StatusBadge status={outcome.status} label={outcome.label} size="small" />{' '}
      <span className={styles.meta}>
        {validation.scope === 'case' ? 'one case only' : 'full run'}
      </span>
    </li>
  );
}

/** Versions the current one was built from (through `parentVersionId`), newest first: the only ones a rollback may restore. */
export function restorableVersions(detail: SkillDetail): SkillDetail['versions'] {
  const byId = new Map(detail.versions.map((version) => [version.id, version]));
  const out: SkillDetail['versions'] = [];
  const seen = new Set<string>();
  let cursor =
    byId.get(detail.currentVersion.id)?.parentVersionId ?? detail.currentVersion.parentVersionId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const version = byId.get(cursor);
    if (!version) break;
    if (version.state === 'active' || version.state === 'superseded') out.push(version);
    cursor = version.parentVersionId;
  }
  return out;
}

function ProposedVersion({
  detail,
  proposed,
  onReload,
}: {
  detail: SkillDetail;
  proposed: SkillVersion;
  onReload: () => void;
}) {
  const styles = useInsightStyles();
  const toast = useToast();
  const actor = useActorLabel();
  const me = useCurrentUserId();
  const decide = useApiMutation('skills.versionDecision', { invalidate: SKILL_INVALIDATES });
  const { skill } = detail;
  const withdrawn = isWithdrawn(skill.lifecycle);
  const ownProposal = me !== null && (me === proposed.createdBy || me === skill.createdBy);
  const approveBlocked = withdrawn
    ? `A ${skill.lifecycle} skill cannot take a new version.`
    : ownProposal
      ? 'You created this skill or proposed this change, so someone else must approve it (the four-eyes rule).'
      : null;
  const rejectBlocked = withdrawn ? `A ${skill.lifecycle} skill cannot take a new version.` : null;

  const run = async (decision: 'approve' | 'reject', reason: string): Promise<void> => {
    try {
      await decide.mutateAsync({
        params: { skillId: skill.id, versionId: proposed.id },
        body: { decision, reason, expectedVersion: skill.version },
      });
      toast.success(
        decision === 'approve'
          ? `Version ${proposed.version} approved`
          : `Version ${proposed.version} rejected`,
        {
          body:
            decision === 'approve'
              ? 'It is now the current version. The decision is recorded with your name and reason.'
              : 'The proposal was not applied. The decision is recorded with your name and reason.',
        },
      );
    } catch (error) {
      const failure = explainFailure(error, { lifecycleStep: true });
      if (needsReload(failure)) onReload();
      throw new Error(failureText(failure), { cause: error });
    }
  };

  return (
    <Panel
      title={`Proposed version ${proposed.version}`}
      description="A change learned from another case. It is never applied on its own."
      help="A proposed change waits for a decision. Approving needs someone other than the skill's creator and the author of the proposal, and the new content must have passed a full simulation test and the regression suite. Rejecting needs only a reason. Nothing changes until someone decides."
      actions={<StatusBadge status="uncertain" label="Waiting for a decision" />}
    >
      <ClampedText text={proposed.changeSummary} lines={4} label="summary of the proposed change" />
      <p className={styles.meta}>
        Proposed by {actor(proposed.createdBy)} on {formatDateTimeUtc(proposed.createdAt)}; it
        builds on version{' '}
        {detail.versions.find((version) => version.id === proposed.parentVersionId)?.version ??
          'unknown'}
        .
      </p>
      <p className={styles.itemTitle}>Checks on this version</p>
      <ul className={styles.bullets} aria-label="Validations of the proposed version">
        <GateLine
          validation={latestFor(detail.validations, proposed.id, 'simulation_test')}
          kind="simulation_test"
        />
        <GateLine
          validation={latestFor(detail.validations, proposed.id, 'regression')}
          kind="regression"
        />
      </ul>
      <Notice variant="info" compact title="Who can decide">
        Approval needs someone other than {actor(skill.createdBy)} (who created the skill) and{' '}
        {actor(proposed.createdBy)} (who proposed this change). Run the simulation test and the
        regression suite on this version first (Validation tab).
      </Notice>
      <div className={styles.actions}>
        <GatedConfirm
          permission="skill:approve"
          blockedReason={approveBlocked}
          trigger={<Button appearance="primary">Approve version {proposed.version}</Button>}
          title={`Approve version ${proposed.version}?`}
          confirmLabel="Approve"
          reason={{
            label: 'Reason for approving (kept with the decision)',
            minLength: 5,
            maxLength: 1000,
          }}
          onConfirm={(reason) => run('approve', reason)}
        >
          <p>
            Version {proposed.version} becomes the current version of this skill. The previous
            version is kept in the history and can be restored.
            {skill.lifecycle === 'expert_reviewed'
              ? ' Because the skill was expert reviewed, it goes back to Simulation Tested so the new content is reviewed again.'
              : ''}
          </p>
        </GatedConfirm>
        <GatedConfirm
          permission="skill:approve"
          blockedReason={rejectBlocked}
          trigger={<Button appearance="outline">Reject version {proposed.version}</Button>}
          title={`Reject version ${proposed.version}?`}
          confirmLabel="Reject"
          tone="danger"
          reason={{
            label: 'Reason for rejecting (kept with the decision)',
            minLength: 5,
            maxLength: 1000,
          }}
          onConfirm={(reason) => run('reject', reason)}
        >
          <p>The proposal is closed without being applied. The current version stays as it is.</p>
        </GatedConfirm>
      </div>
    </Panel>
  );
}

function ProposeChange({ detail }: { detail: SkillDetail }) {
  const styles = useInsightStyles();
  const toast = useToast();
  const refresh = useRefreshSkills();
  const { analysed } = useAnalysedCases();
  const propose = useApiMutation('skills.proposeMutation', { invalidate: ['jobs.list'] });
  const [source, setSource] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const { skill } = detail;
  const withdrawn = isWithdrawn(skill.lifecycle);
  const candidates = analysed.filter((item) => !skill.sourceCaseIds.includes(item.id));
  const chosen =
    source && candidates.some((item) => item.id === source) ? source : (candidates[0]?.id ?? '');
  const blocked = withdrawn
    ? `A ${skill.lifecycle} skill cannot take a new version.`
    : candidates.length === 0
      ? 'There is no other analysed case to learn from. Analyse another case first.'
      : null;
  return (
    <Panel
      title="Propose a change from another case"
      description="Learn from a case the skill was not built on. The result is a proposal, never an automatic change."
      help="The engine compares how another analysed case went with the skill and, where it found something worth adding (a trigger, a step, a failure mode), writes a proposed new version. Someone else then approves or rejects it."
    >
      <div className={styles.toolbar}>
        <Field label="Learn from this case" className={styles.field}>
          <Select
            className={styles.select}
            value={chosen}
            disabled={candidates.length === 0}
            onChange={(_event, next) => setSource(next.value)}
          >
            {candidates.map((item) => (
              <option key={item.id} value={item.id}>
                {item.reference} · {item.title}
              </option>
            ))}
          </Select>
        </Field>
        <GatedConfirm
          permission="skill:mutate"
          blockedReason={blocked}
          trigger={<Button appearance="outline">Propose a change</Button>}
          title="Propose a change from this case?"
          confirmLabel="Start the proposal"
          onConfirm={async () => {
            try {
              const response = await propose.mutateAsync({
                params: { skillId: skill.id },
                body: { sourceCaseId: chosen },
              });
              setJobId(response.job.id);
            } catch (error) {
              throw new Error(failureText(explainFailure(error)), { cause: error });
            }
          }}
        >
          <p>
            The engine reads the chosen case and drafts a proposed version of this skill. It runs in
            the background, then waits for a decision from someone else. The current version does
            not change.
          </p>
        </GatedConfirm>
      </div>
      {blocked ? <p className={styles.meta}>{blocked}</p> : null}
      {jobId ? (
        <JobProgress
          jobId={jobId}
          title="Drafting a proposed version"
          level={3}
          onTerminal={(job) => {
            refresh();
            if (job.status === 'succeeded') {
              toast.success('A proposed version is ready for review', {
                body: 'Someone other than its author has to approve it.',
              });
            }
          }}
        />
      ) : null}
    </Panel>
  );
}

function Rollback({ detail, onReload }: { detail: SkillDetail; onReload: () => void }) {
  const styles = useInsightStyles();
  const toast = useToast();
  const rollback = useApiMutation('skills.rollback', { invalidate: SKILL_INVALIDATES });
  const [target, setTarget] = useState('');
  const options = useMemo(() => restorableVersions(detail), [detail]);
  const { skill } = detail;
  const chosen =
    target && options.some((version) => version.id === target) ? target : (options[0]?.id ?? '');
  const chosenVersion = options.find((version) => version.id === chosen);
  const blocked = isWithdrawn(skill.lifecycle)
    ? `A ${skill.lifecycle} skill cannot be rolled back.`
    : options.length === 0
      ? 'There is no earlier version to restore: only a version the current one was built from can come back.'
      : null;
  return (
    <Panel
      title="Roll back to an earlier version"
      description="Restores earlier content by creating a new version. Nothing is deleted or rewritten."
      help="A rollback adds a new version whose content equals an earlier one, and the version it replaces stays in the history. Only a version the current one was built from can be restored; a version that an earlier rollback withdrew has to be proposed again as a new version with its own approval."
    >
      <div className={styles.toolbar}>
        <Field label="Restore the content of" className={styles.field}>
          <Select
            className={styles.select}
            value={chosen}
            disabled={options.length === 0}
            onChange={(_event, next) => setTarget(next.value)}
          >
            {options.map((version) => (
              <option key={version.id} value={version.id}>
                Version {version.version} ({SKILL_LIFECYCLE_LABELS[version.lifecycleAtCreation]}{' '}
                when created)
              </option>
            ))}
          </Select>
        </Field>
        <GatedConfirm
          permission="skill:rollback"
          blockedReason={blocked}
          trigger={<Button appearance="outline">Roll back</Button>}
          title={chosenVersion ? `Roll back to version ${chosenVersion.version}?` : 'Roll back?'}
          confirmLabel="Roll back"
          tone="danger"
          reason={{
            label: 'Reason for rolling back (kept with the new version)',
            minLength: 5,
            maxLength: 1000,
          }}
          onConfirm={async (reason) => {
            try {
              await rollback.mutateAsync({
                params: { skillId: skill.id },
                body: { toVersionId: chosen, reason, expectedVersion: skill.version },
              });
              toast.success('Rolled back', {
                body: 'A new version with the earlier content is now current. The history is unchanged.',
              });
            } catch (error) {
              const failure = explainFailure(error, { rollback: true });
              if (needsReload(failure)) onReload();
              throw new Error(failureText(failure), { cause: error });
            }
          }}
        >
          <p>
            A new version with the content of version {chosenVersion?.version} becomes current, and
            version {detail.currentVersion.version} is kept as superseded. The restored content must
            still hold the validations this skill&apos;s stage requires.
          </p>
        </GatedConfirm>
      </div>
      {blocked ? <p className={styles.meta}>{blocked}</p> : null}
    </Panel>
  );
}

export interface ChangesPanelsProps {
  detail: SkillDetail;
  onReload: () => void;
}

/** The proposed change waiting for a decision, if there is one. */
export function ProposalSection({ detail, onReload }: ChangesPanelsProps) {
  if (!detail.proposedVersion) return null;
  return <ProposedVersion detail={detail} proposed={detail.proposedVersion} onReload={onReload} />;
}

/** The two other ways a skill's content can change: proposing a change from a case, and rollback. */
export function ManageSection({ detail, onReload }: ChangesPanelsProps) {
  const styles = useInsightStyles();
  return (
    <div className={styles.band}>
      <ProposeChange detail={detail} />
      <Rollback detail={detail} onReload={onReload} />
    </div>
  );
}
