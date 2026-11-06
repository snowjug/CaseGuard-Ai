'use client';

import type { SkillDetail, SkillMatch } from '@caseguard/schemas';
import { Button, Field, Select, cg } from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';
import { ZapIcon } from 'lucide-react';
import { useState } from 'react';
import { useApiMutation } from '../../lib/api/hooks';
import { useSession } from '../../lib/auth/session';
import { useToast } from '../../lib/toast';
import { explainFailure, failureText } from '../quality/failure';
import { GatedConfirm } from '../quality/GatedConfirm';
import { useAnalysedCases } from './hooks';
import { isWithdrawn } from './labels';
import { APPLY_INVALIDATES } from './SkillMatchCard';

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: cg.space[3] },
  select: { width: '100%' },
  text: { margin: 0 },
});

/** What applying a skill recorded: the match, and the reference of the case it was recorded on. */
export interface AppliedRecord {
  match: SkillMatch;
  caseReference: string | null;
}

function ApplyControl({
  detail,
  onApplied,
}: {
  detail: SkillDetail;
  onApplied: (record: AppliedRecord) => void;
}) {
  const styles = useStyles();
  const toast = useToast();
  const { analysed, isPending } = useAnalysedCases();
  const apply = useApiMutation('skills.apply', { invalidate: APPLY_INVALIDATES });
  const [caseId, setCaseId] = useState('');
  const { skill } = detail;
  const chosen =
    caseId && analysed.some((item) => item.id === caseId) ? caseId : (analysed[0]?.id ?? '');
  // While the cases load, the button is busy rather than blocked: "no case" is only said once the list has arrived.
  const blocked = isWithdrawn(skill.lifecycle)
    ? `A ${skill.lifecycle} skill can no longer be applied.`
    : !isPending && analysed.length === 0
      ? 'There is no analysed case to apply it to.'
      : null;
  return (
    <GatedConfirm
      permission="skill:apply"
      blockedReason={blocked}
      trigger={
        <Button variant="primary" icon={<ZapIcon />} loading={isPending && blocked === null}>
          Apply to a case
        </Button>
      }
      title="Apply this skill to a case?"
      confirmLabel="Apply skill"
      onConfirm={async () => {
        try {
          const match = await apply.mutateAsync({
            params: { caseId: chosen },
            body: { skillId: skill.id },
          });
          toast.success('Skill applied', {
            body: 'The adoption is recorded in the audit log with how closely the plan was followed.',
          });
          onApplied({
            match,
            caseReference: analysed.find((item) => item.id === chosen)?.reference ?? null,
          });
        } catch (error) {
          throw new Error(failureText(explainFailure(error)), { cause: error });
        }
      }}
    >
      <div className={styles.body}>
        <Field label="Case">
          <Select
            className={styles.select}
            value={chosen}
            disabled={analysed.length === 0}
            onChange={(event) => setCaseId(event.target.value)}
          >
            {analysed.map((item) => (
              <option key={item.id} value={item.id}>
                {item.reference} · {item.title}
              </option>
            ))}
          </Select>
        </Field>
        <p className={styles.text}>
          Applying records that the guided plan of “{skill.name}” was adopted for the chosen case.
          It does not run anything or change the case, and the record is audited.
        </p>
      </div>
    </GatedConfirm>
  );
}

export interface ApplyToCaseProps {
  detail: SkillDetail;
  /** Called after the application was recorded, with the match the API answered. */
  onApplied: (record: AppliedRecord) => void;
}

/**
 * The one primary action of a skill's page: "Apply to a case". It is offered only to a role that may apply skills; for
 * that role it explains, as a tooltip on the disabled button, why a withdrawn skill or a workspace without an analysed
 * case cannot take it. Applying records that the plan was adopted (audited); it never runs anything or changes the case.
 */
export function ApplyToCase({ detail, onApplied }: ApplyToCaseProps) {
  const { can } = useSession();
  if (!can('skill:apply')) return null;
  return <ApplyControl detail={detail} onApplied={onApplied} />;
}
