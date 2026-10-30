'use client';

import type { SkillDetail, SkillValidation } from '@caseguard/schemas';
import {
  EmptyState,
  Notice,
  Panel,
  ProvenanceBadge,
  StatusBadge,
  UiLink,
  formatDateTimeUtc,
} from '@caseguard/ui';
import { Button, Field, Select } from '@fluentui/react-components';
import {
  CheckmarkCircleRegular,
  DismissCircleRegular,
  TaskListSquareLtrRegular,
} from '@fluentui/react-icons';
import { useState } from 'react';
import { useApiMutation } from '../../lib/api/hooks';
import { shortId } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { useActorLabel } from '../quality/actors';
import { explainFailure, failureText, needsReload } from '../quality/failure';
import { GatedConfirm } from '../quality/GatedConfirm';
import { useInsightStyles } from '../quality/styles';
import { SKILL_INVALIDATES, useAnalysedCases } from './hooks';
import { VALIDATION_KIND_LABELS, VALIDATION_OUTCOMES } from './labels';

const SCOPE_HELP =
  "A full run replays the whole set for its kind: every case the skill was derived from for a simulation test, and the workload's other analysed cases for the regression suite. Only a full run of the current content can open or fail a lifecycle step. A run on one case is recorded as inconclusive with its real check results, so it is informative but never satisfies a gate and never replaces the verdict of an earlier full run.";

/** A validation without a scope was written before the field existed and counts as a full run. */
export function scopeOf(validation: Pick<SkillValidation, 'scope'>): 'full' | 'case' {
  return validation.scope === 'case' ? 'case' : 'full';
}

function ValidationItem({
  validation,
  detail,
}: {
  validation: SkillValidation;
  detail: SkillDetail;
}) {
  const styles = useInsightStyles();
  const actor = useActorLabel();
  const { analysed } = useAnalysedCases();
  const outcome = VALIDATION_OUTCOMES[validation.outcome];
  const scope = scopeOf(validation);
  const version = detail.versions.find((item) => item.id === validation.versionId);
  const caseRef = analysed.find((item) => item.id === validation.caseId)?.reference;
  return (
    <li className={styles.item}>
      <div className={styles.itemHead}>
        <h3 className={styles.itemTitle}>{VALIDATION_KIND_LABELS[validation.kind]}</h3>
        <StatusBadge status={outcome.status} label={outcome.label} size="small" />
        <StatusBadge
          status={scope === 'full' ? 'neutral' : 'uncertain'}
          label={scope === 'full' ? 'Full run' : 'One case only'}
          size="small"
        />
        <span className={styles.meta}>
          version {version?.version ?? shortId(validation.versionId)}
          {version?.state === 'proposed' ? ' (proposed)' : ''}
        </span>
        {validation.synthetic ? <ProvenanceBadge kind="synthetic" size="small" /> : null}
      </div>
      <p className={styles.meta}>
        Run by {actor(validation.executedBy)} on {formatDateTimeUtc(validation.executedAt)}
        {validation.caseId ? (
          <>
            {' · case '}
            <UiLink
              href={`/cases/${encodeURIComponent(validation.caseId)}`}
              className={styles.link}
            >
              {caseRef ?? shortId(validation.caseId)}
            </UiLink>
          </>
        ) : (
          ' · every case in the set'
        )}
      </p>
      {scope === 'case' ? (
        <p className={styles.text}>
          A run on one case does not satisfy the gate: its checks below are real, but only a full
          run counts towards a lifecycle step.
        </p>
      ) : null}
      <ul
        className={styles.list}
        aria-label={`Checks of the ${VALIDATION_KIND_LABELS[validation.kind].toLowerCase()}`}
      >
        {validation.checks.map((check) => (
          <li key={check.id} className={styles.itemHead}>
            {check.passed ? (
              <CheckmarkCircleRegular aria-hidden="true" />
            ) : (
              <DismissCircleRegular aria-hidden="true" />
            )}
            <span className={styles.text}>
              <span className={styles.strong}>{check.passed ? 'Passed' : 'Failed'}:</span>{' '}
              {check.detail}
            </span>
          </li>
        ))}
      </ul>
    </li>
  );
}

function RunPanel({ detail, onReload }: { detail: SkillDetail; onReload: () => void }) {
  const styles = useInsightStyles();
  const toast = useToast();
  const { analysed } = useAnalysedCases();
  const run = useApiMutation('skills.simulationTest', { invalidate: SKILL_INVALIDATES });
  const [version, setVersion] = useState('');
  const [scope, setScope] = useState('');
  const { skill, currentVersion, proposedVersion } = detail;
  const versionId = version === proposedVersion?.id ? version : currentVersion.id;
  const onlyCase = scope && analysed.some((item) => item.id === scope) ? scope : '';

  const execute = (kind: 'simulation_test' | 'regression') => async (): Promise<void> => {
    try {
      const validation = await run.mutateAsync({
        params: { skillId: skill.id },
        body: {
          kind,
          ...(versionId !== currentVersion.id ? { versionId } : {}),
          ...(onlyCase ? { caseId: onlyCase } : {}),
        },
      });
      const outcome = VALIDATION_OUTCOMES[validation.outcome].label.toLowerCase();
      toast.info(`${VALIDATION_KIND_LABELS[kind]} ${outcome}`, {
        body:
          scopeOf(validation) === 'case'
            ? 'A run on one case does not satisfy the gate: only a full run counts.'
            : 'The result is recorded with the version it ran on.',
      });
    } catch (error) {
      const failure = explainFailure(error);
      if (needsReload(failure)) onReload();
      throw new Error(failureText(failure), { cause: error });
    }
  };

  const explain = (
    <p>
      The skill is replayed {onlyCase ? 'on the chosen case only' : 'on every case in its set'}{' '}
      using only what was known at each decision point, and the result is recorded.{' '}
      {onlyCase
        ? 'A run on one case is informative only: it does not satisfy a lifecycle gate.'
        : 'A full run can open or fail a lifecycle gate.'}
    </p>
  );
  return (
    <Panel
      title="Run a check"
      description="Replays the skill and records the result. Nothing is executed against a real system."
      help={SCOPE_HELP}
    >
      <div className={styles.toolbar}>
        <Field label="Version" className={styles.field}>
          <Select
            className={styles.select}
            value={versionId}
            onChange={(_event, next) => setVersion(next.value)}
          >
            <option value={currentVersion.id}>Current version {currentVersion.version}</option>
            {proposedVersion ? (
              <option value={proposedVersion.id}>Proposed version {proposedVersion.version}</option>
            ) : null}
          </Select>
        </Field>
        <Field label="Cases" className={styles.field}>
          <Select
            className={styles.select}
            value={onlyCase}
            onChange={(_event, next) => setScope(next.value)}
          >
            <option value="">Every case in the set (full run)</option>
            {analysed.map((item) => (
              <option key={item.id} value={item.id}>
                Only {item.reference} (informational)
              </option>
            ))}
          </Select>
        </Field>
        <GatedConfirm
          permission="skill:validate"
          trigger={<Button appearance="primary">Run simulation test</Button>}
          title="Run the simulation test?"
          confirmLabel="Run simulation test"
          onConfirm={execute('simulation_test')}
        >
          {explain}
        </GatedConfirm>
        <GatedConfirm
          permission="skill:validate"
          trigger={<Button appearance="outline">Run regression suite</Button>}
          title="Run the regression suite?"
          confirmLabel="Run regression suite"
          onConfirm={execute('regression')}
        >
          {explain}
        </GatedConfirm>
      </div>
    </Panel>
  );
}

export interface ValidationTabProps {
  detail: SkillDetail;
  onReload: () => void;
}

/** The "Validation" tab: every recorded run with its scope and real checks, and controls to run a new one. */
export function ValidationTab({ detail, onReload }: ValidationTabProps) {
  const styles = useInsightStyles();
  const validations = [...detail.validations].sort((a, b) =>
    a.executedAt < b.executedAt ? 1 : -1,
  );
  return (
    <div className={styles.page}>
      <Notice variant="info" compact title="Only a full run counts">
        A run on one case does not satisfy the gate. Only a full run of the current content,
        covering the whole set for its kind, can open or fail a lifecycle step.
      </Notice>
      <RunPanel detail={detail} onReload={onReload} />
      <Panel
        title="Recorded runs"
        description="Newest first, with the version each ran on."
        help={SCOPE_HELP}
      >
        {validations.length === 0 ? (
          <EmptyState
            compact
            headingLevel={3}
            icon={<TaskListSquareLtrRegular />}
            title="No validation has been run"
            description="A skill needs a passed full simulation test before it can be reviewed, and a regression run before it is validated."
          />
        ) : (
          <ul className={styles.list} aria-label="Validation runs">
            {validations.map((validation) => (
              <ValidationItem key={validation.id} validation={validation} detail={detail} />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
