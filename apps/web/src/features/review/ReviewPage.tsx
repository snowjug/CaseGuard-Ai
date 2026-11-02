'use client';

import { LoadingSkeleton, PageHeader, ProvenanceBadge, cg } from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';
import { DocumentTextRegular, FolderRegular } from '@fluentui/react-icons';
import { useCaseDetail } from '../../components/case/case-hooks';
import { CaseNotFoundState } from '../../components/case/CaseNotFoundState';
import { NotAnalysedState, isNotAnalysedError } from '../../components/case/NotAnalysedState';
import { IdentityRequired } from '../../components/common/IdentityRequired';
import { LinkButton } from '../../components/common/LinkButton';
import { QueryErrorState } from '../../components/common/QueryErrorState';
import { useAuth } from '../../lib/auth/context';
import { caseHref } from '../../lib/deep-links';
import { EvidenceProvider } from './evidence/EvidenceProvider';
import { useForksHandle } from './hooks';
import { SectionNav } from './SectionNav';
import { ActionsSection } from './sections/ActionsSection';
import { ChronologySection } from './sections/ChronologySection';
import { DecisionsSection } from './sections/DecisionsSection';
import { LearningSection } from './sections/LearningSection';
import { OverallMethod } from './sections/OverallMethod';
import { PathsSection } from './sections/PathsSection';
import { ShareSection } from './sections/ShareSection';
import { VerdictSection } from './sections/VerdictSection';

const useStyles = makeStyles({
  flow: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
});

const PAGE_HELP = (
  <>
    <p>
      One guided read of the case: the verdict first, then when it started to go wrong, what a
      better-supported path would have looked like, what to do next and what to learn from it.
    </p>
    <p>
      Every figure is an estimate or a simulation and says so. Wherever a statement rests on
      evidence you can open it and read the stored message it came from. Each section explains how
      it was calculated.
    </p>
    <p>
      A decision point is a moment when the case could have gone another way. A better-supported
      path is a simulated alternative for a decision point. Evidence is the messages and signals a
      statement rests on. Case quality estimates how well the record supports a decision. Avoidable
      support effort estimates the work a better-supported path would have saved. A reusable skill
      is a pattern from a past case that can be applied to a new one.
    </p>
  </>
);

/**
 * Guided case review (`/cases/[caseId]/review`): one scrolling page that reads the case in the order a person decides:
 * the verdict, the chronology, what went wrong, what should have happened, what to do next, what to learn, and how to
 * share it. Each section reads only what it needs, so a role that may not read one part still gets the rest, and a
 * failed read fails only its own section. Evidence opens in one drawer from anywhere on the page.
 */
export function ReviewPage({ caseId }: { caseId: string }) {
  const styles = useStyles();
  const auth = useAuth();
  const detail = useCaseDetail(caseId);
  const forks = useForksHandle(caseId);
  const data = detail.data;

  const header = (
    <PageHeader
      title="Guided review"
      description={
        data
          ? `${data.reference} · ${data.title}`
          : 'The verdict, the chronology, what went wrong and what to do next.'
      }
      help={PAGE_HELP}
      meta={
        <>
          <ProvenanceBadge kind="estimated" />
          {data?.synthetic ? <ProvenanceBadge kind="synthetic" /> : null}
        </>
      }
      actions={
        <div className={styles.actions}>
          <LinkButton
            href={caseHref(caseId, 'report')}
            appearance="outline"
            icon={<DocumentTextRegular />}
          >
            Report
          </LinkButton>
          <LinkButton href={caseHref(caseId)} appearance="outline" icon={<FolderRegular />}>
            Case overview
          </LinkButton>
        </div>
      }
    />
  );

  if (detail.isError && detail.error.isNotFound) return <CaseNotFoundState />;

  if (auth.status === 'unauthenticated') {
    return (
      <>
        {header}
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
        {header}
        <NotAnalysedState
          caseId={caseId}
          subject="the guided review"
          analysisState={data?.analysisState}
        />
      </>
    );
  }

  if (!data && !detail.isError) {
    return (
      <>
        {header}
        <LoadingSkeleton variant="card" count={3} label="Loading the guided review" />
      </>
    );
  }

  return (
    <>
      {header}
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
          <VerdictSection caseId={caseId} />
          <ChronologySection caseId={caseId} />
          <DecisionsSection caseId={caseId} />
          <PathsSection caseId={caseId} />
          <ActionsSection caseId={caseId} />
          <LearningSection caseId={caseId} />
          <ShareSection caseId={caseId} />
          <OverallMethod caseId={caseId} />
        </div>
      </EvidenceProvider>
    </>
  );
}
