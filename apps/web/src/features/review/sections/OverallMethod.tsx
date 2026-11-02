'use client';

import { cg } from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';
import { useCoachingHandle, useDetailHandle, useQualityHandle, useRunHandle } from '../hooks';
import { methodNotes } from '../model/method';
import { MethodDisclosure } from './shared';

const useStyles = makeStyles({
  frame: {
    padding: cg.space[4],
    borderRadius: cg.radius.lg,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surface,
    minWidth: 0,
  },
  plain: { borderTopStyle: 'none', paddingTop: 0 },
});

/** The note that explains the review as a whole, after its last section: where the figures come from and what they are not. */
export function OverallMethod({ caseId }: { caseId: string }) {
  const styles = useStyles();
  const run = useRunHandle(caseId);
  const quality = useQualityHandle(caseId);
  const coaching = useCoachingHandle(caseId);
  const detail = useDetailHandle(caseId);
  const notes = methodNotes('overall', {
    run: run.source.kind === 'ready' ? run.source.data : null,
    quality: quality.source.kind === 'ready' ? quality.source.data : null,
    qualityDenied: quality.source.kind === 'denied',
    coaching: coaching.source.kind === 'ready' ? coaching.source.data : null,
    detail: detail.source.kind === 'ready' ? detail.source.data : null,
    path: null,
  });
  return (
    <div className={styles.frame}>
      <MethodDisclosure
        notes={notes}
        summary="How this whole review was calculated"
        className={styles.plain}
      />
    </div>
  );
}
