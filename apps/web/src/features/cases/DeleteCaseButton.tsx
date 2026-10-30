'use client';

import { ConfirmDialog } from '@caseguard/ui';
import { Button } from '@fluentui/react-components';
import { DeleteRegular } from '@fluentui/react-icons';
import { useActiveCase } from '../../lib/active-case';
import { describeError } from '../../lib/api/errors';
import { useApiMutation } from '../../lib/api/hooks';
import { hasReason } from '../../lib/api/reason';
import { GatedAction, useSession } from '../../lib/auth/session';
import { useToast } from '../../lib/toast';

/** The `Problem.reason` of the 409 that refuses to delete a case while one of its jobs is queued or running. */
export const JOB_ACTIVE_REASON = 'job_active';

/** What the person sees when a delete is refused: the reason token picks the explanation, never the API's wording. */
export function explainDeleteError(error: unknown): string {
  if (hasReason(error, JOB_ACTIVE_REASON, 'conflict')) {
    return 'A job for this case is still queued or running, so it cannot be deleted yet. Cancel the job from the case page, or wait until it has finished, then delete the case.';
  }
  return describeError(error);
}

export interface DeleteCaseButtonProps {
  caseId: string;
  reference: string;
  title: string;
  /** `icon` for table rows (the accessible name carries the reference), `text` for the overview. */
  display?: 'icon' | 'text';
  /** Called after the API confirmed the deletion. */
  onDeleted?: () => void;
}

/**
 * Administrator erasure of a case. The button is always visible; without `case:delete` it is disabled with the reason.
 * The confirmation says exactly what is removed, the API refuses while a job still runs (409, shown in the dialog),
 * and the result is announced with a toast.
 */
export function DeleteCaseButton({
  caseId,
  reference,
  title,
  display = 'icon',
  onDeleted,
}: DeleteCaseButtonProps) {
  const { can } = useSession();
  const toast = useToast();
  const { caseId: activeCaseId, setActiveCase } = useActiveCase();
  const remove = useApiMutation('cases.delete', {
    invalidate: ['cases.list', 'dashboard.commandCenter'],
  });

  const label = `Delete ${reference}`;
  const button = (
    <Button
      appearance={display === 'icon' ? 'subtle' : 'outline'}
      icon={<DeleteRegular />}
      aria-label={display === 'icon' ? label : undefined}
      title={display === 'icon' ? label : undefined}
    >
      {display === 'text' ? 'Delete case' : null}
    </Button>
  );

  if (!can('case:delete')) {
    return <GatedAction permission="case:delete">{button}</GatedAction>;
  }

  return (
    <ConfirmDialog
      trigger={button}
      tone="danger"
      title={`Delete ${reference}?`}
      confirmLabel="Delete case"
      onConfirm={async () => {
        try {
          await remove.mutateAsync({ params: { caseId } });
        } catch (error) {
          throw new Error(explainDeleteError(error), { cause: error });
        }
        if (activeCaseId === caseId) setActiveCase(null);
        toast.success(`Deleted ${reference}`, {
          body: 'The case and everything derived from it were removed.',
        });
        onDeleted?.();
      }}
    >
      <p>
        This permanently deletes <strong>{title}</strong> and everything derived from it: its
        events, analysis results, scenarios, skill matches and jobs, and the stored copy of the
        original payload. Only counts are kept in the audit log. This cannot be undone.
      </p>
    </ConfirmDialog>
  );
}
