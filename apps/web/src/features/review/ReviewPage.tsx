'use client';

import {
  BlurFade,
  Button,
  Card,
  PageHeader,
  ProvenanceBadge,
  Skeleton,
  SkeletonText,
  cg,
  copyText,
} from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';
import { CopyIcon } from 'lucide-react';
import { useCaseDetail } from '../../components/case/case-hooks';
import { CaseNotFoundState } from '../../components/case/CaseNotFoundState';
import { NotAnalysedState, isNotAnalysedError } from '../../components/case/NotAnalysedState';
import { IdentityRequired } from '../../components/common/IdentityRequired';
import { QueryErrorState } from '../../components/common/QueryErrorState';
import { useAuth } from '../../lib/auth/context';
import { useToast } from '../../lib/toast';
import { EvidenceProvider } from './evidence/EvidenceProvider';
import { useForksHandle } from './hooks';
import { fixListText } from './model/actions';
import { SectionNav } from './SectionNav';
import { ActionsSection } from './sections/ActionsSection';
import { ChronologySection } from './sections/ChronologySection';
import { DecisionsSection } from './sections/DecisionsSection';
import { EvidenceSection } from './sections/EvidenceSection';
import { LearningSection } from './sections/LearningSection';
import { OverallMethod } from './sections/OverallMethod';
import { PathsSection } from './sections/PathsSection';
import { ShareSection } from './sections/ShareSection';
import { VerdictSection } from './sections/VerdictSection';
import { useNextActions } from './use-next-actions';

const useStyles = makeStyles({
  flow: { display: 'flex', flexDirection: 'column', gap: cg.space[6], minWidth: 0 },
  hero: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    gap: cg.space[6],
    alignItems: 'start',
    '@media (min-width: 1200px)': { gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' },
  },
  skeleton: { display: 'flex', flexDirection: 'column', gap: cg.space[6] },
  skeletonHero: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[6] },
  skeletonCopy: { display: 'flex', flexDirection: 'column', gap: cg.space[3], flex: '1 1 200px' },
  skeletonStack: { display: 'flex', flexDirection: 'column', gap: cg.space[3] },
});

const PAGE_HELP = (
  <>
    <p>
      How the case went, what to fix first and what would have changed the outcome. Every figure is
      an estimate or a simulation and says so. Open any piece of evidence to read the stored message
      it came from.
    </p>
    <ul>
      <li>Decision point: a moment when the case could have gone another way.</li>
      <li>Better-supported path: a simulated alternative for a decision point.</li>
      <li>Evidence: the messages and signals a statement rests on.</li>
      <li>Case quality: an estimate of how well the record supports a decision.</li>
      <li>
        Time that could have been saved: an estimate of the work a better-supported path would have
        saved.
      </li>
      <li>Reusable skill: a pattern from a past case that can be applied to a new one.</li>
    </ul>
  </>
);

/** The one primary action of the page: the ranked fixes as plain text, ready to paste into a chat or a ticket. */
function CopyFixList({ caseId, heading }: { caseId: string; heading: string }) {
  const toast = useToast();
  const { model } = useNextActions(caseId);
  const empty = model.items.length === 0;
  const copy = async (): Promise<void> => {
    if (empty) return;
    const ok = await copyText(fixListText(heading, model.items));
    if (ok) toast.success('Fix list copied', { body: 'It is on your clipboard.' });
    else toast.error('The fix list could not be copied', { body: 'Open each fix and copy it.' });
  };
  return (
    <Button
      variant="primary"
      icon={<CopyIcon />}
      disabledFocusable={empty}
      onClick={() => void copy()}
    >
      Copy fix list
    </Button>
  );
}

/** The review while it loads: the verdict beside the fixes, then the sections under them. */
function ReviewSkeleton() {
  const styles = useStyles();
  return (
    <div className={styles.skeleton} role="status" aria-busy="true" aria-label="Loading the review">
      <Skeleton height={48} radius="lg" />
      <div className={styles.hero}>
        <Card padding="lg">
          <div className={styles.skeletonHero}>
            <Skeleton width={168} height={168} radius="pill" />
            <div className={styles.skeletonCopy}>
              <Skeleton width={96} height={22} radius="pill" />
              <Skeleton width="90%" height={24} />
              <SkeletonText lines={2} />
            </div>
          </div>
        </Card>
        <Card padding="lg">
          <div className={styles.skeletonStack}>
            <Skeleton width={120} height={24} />
            <Skeleton height={96} radius="md" />
            <Skeleton height={96} radius="md" />
            <Skeleton height={96} radius="md" />
          </div>
        </Card>
      </div>
      <Card padding="lg">
        <div className={styles.skeletonStack}>
          <Skeleton width={160} height={24} />
          <SkeletonText lines={3} />
        </div>
      </Card>
    </div>
  );
}

/**
 * The review (`/cases/[caseId]/review`): one scrolling page that reads the case in the order a person decides: the
 * verdict beside the first fixes, the evidence, what would have changed the outcome, what happened, what went wrong,
 * what to learn, and how to share it. Each section reads only what it needs, so a role that may not read one part still
 * gets the rest, and a failed read fails only its own section. Evidence opens in one drawer from anywhere on the page.
 */
export function ReviewPage({ caseId }: { caseId: string }) {
  const styles = useStyles();
  const auth = useAuth();
  const detail = useCaseDetail(caseId);
  const forks = useForksHandle(caseId);
  const data = detail.data;

  const header = (withActions: boolean) => (
    <PageHeader
      title="Review"
      description="How the case went, what to fix first and what would have changed the outcome."
      help={PAGE_HELP}
      meta={
        <>
          <ProvenanceBadge kind="estimated" />
          {data?.synthetic ? <ProvenanceBadge kind="synthetic" /> : null}
        </>
      }
      {...(withActions && data
        ? {
            actions: (
              <CopyFixList
                caseId={caseId}
                heading={`CaseGuard fix list: ${data.reference}, ${data.title}`}
              />
            ),
          }
        : {})}
    />
  );

  if (detail.isError && detail.error.isNotFound) return <CaseNotFoundState />;

  if (auth.status === 'unauthenticated') {
    return (
      <>
        {header(false)}
        <IdentityRequired />
      </>
    );
  }

  const notAnalysed =
    (data !== undefined && data.analysisState !== 'analyzed') ||
    (forks.source.kind === 'failed' && isNotAnalysedError(forks.source.error));
  if (notAnalysed) {
    return (
      <>
        {header(false)}
        <NotAnalysedState
          caseId={caseId}
          subject="the review"
          analysisState={data?.analysisState}
        />
      </>
    );
  }

  if (!data && !detail.isError) {
    return (
      <>
        {header(false)}
        <ReviewSkeleton />
      </>
    );
  }

  return (
    <>
      {header(true)}
      {detail.isError ? (
        <QueryErrorState
          compact
          subject="The case record"
          error={detail.error}
          onRetry={() => void detail.refetch()}
          retrying={detail.isFetching}
        />
      ) : null}
      <EvidenceProvider caseId={caseId}>
        <div className={styles.flow}>
          <SectionNav />
          <div className={styles.hero}>
            <BlurFade index={0}>
              <VerdictSection caseId={caseId} />
            </BlurFade>
            <BlurFade index={1}>
              <ActionsSection caseId={caseId} />
            </BlurFade>
          </div>
          <BlurFade index={2}>
            <EvidenceSection caseId={caseId} />
          </BlurFade>
          <PathsSection caseId={caseId} />
          <ChronologySection caseId={caseId} />
          <DecisionsSection caseId={caseId} />
          <LearningSection caseId={caseId} />
          <ShareSection caseId={caseId} />
          <OverallMethod caseId={caseId} />
        </div>
      </EvidenceProvider>
    </>
  );
}
