'use client';

import { LoadingSkeleton, Notice, PageHeader, ProvenanceBadge, cg, copyText } from '@caseguard/ui';
import { Button, makeStyles, tokens } from '@fluentui/react-components';
import {
  ArrowDownloadRegular,
  ArrowSyncRegular,
  CopyRegular,
  DocumentTextRegular,
  PrintRegular,
} from '@fluentui/react-icons';
import { useState, useSyncExternalStore } from 'react';
import { useCaseDetail } from '../../../components/case/case-hooks';
import { CaseNotFoundState } from '../../../components/case/CaseNotFoundState';
import { NotAnalysedState } from '../../../components/case/NotAnalysedState';
import { IdentityRequired } from '../../../components/common/IdentityRequired';
import { LinkButton } from '../../../components/common/LinkButton';
import { useAuth } from '../../../lib/auth/context';
import { caseHref } from '../../../lib/deep-links';
import { useToast } from '../../../lib/toast';
import {
  useClaimReviewsHandle,
  useCoachingHandle,
  useDetailHandle,
  useForksHandle,
  useMatchesHandle,
  useMetricsHandle,
  useOverlayHandles,
  useQualityHandle,
  useRankingHandle,
  useRunHandle,
  useScenariosHandle,
  useTimelineHandle,
  useWarningsHandle,
  type Handle,
} from '../hooks';
import { deriveLearning } from '../model/learning';
import { dataOf, type Source } from '../model/sources';
import { useRoleText } from '../sections/shared';
import { downloadFile, buildReportHtml } from './html';
import { REPORT_CSS } from './css';
import { buildReport, reportSummary, REPORT_MATCHES_SHOWN, type ReportInput } from './model';
import { ReportDocument } from './ReportDocument';

const useStyles = makeStyles({
  toolbar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: cg.space[2],
    margin: `0 0 ${cg.space[4]}`,
  },
  note: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textSecondary },
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[3], minWidth: 0 },
});

const PAGE_HELP = (
  <>
    <p>
      The decision-ready version of the guided review, on one page: the verdict, the chronology, the
      earliest missed moment, the recorded and the better-supported path, the recommendations with
      their evidence, what was learned, how it was calculated and who reviewed what.
    </p>
    <p>
      It is built from the same figures as the guided review. A section your role may not read is
      left out, and the report says so. Print it, copy a short summary, or download it as one HTML
      file that opens anywhere without a script.
    </p>
  </>
);

const subscribeNever = (): (() => void) => () => undefined;
const readOrigin = (): string => window.location.origin;
const noOrigin = (): string => '';

/** The address of the app as the browser has it; empty while the page is rendered on the server. */
function useOrigin(): string {
  return useSyncExternalStore(subscribeNever, readOrigin, noOrigin);
}

function sourceOf<T>(handle: Handle<T>): Source<T> {
  return handle.source;
}

/**
 * Decision-ready report (`/cases/[caseId]/report`): the guided review composed as one document for reading, printing,
 * copying as a short summary and downloading as a single HTML file. It reads what the review reads, through the same
 * hooks, and builds the document from the same derivations, so the two never disagree. What the role may not read is left
 * out with a note, and what failed to load is named, with a way to try again.
 */
export function ReportPage({ caseId }: { caseId: string }) {
  const styles = useStyles();
  const auth = useAuth();
  const toast = useToast();
  const role = useRoleText();
  const origin = useOrigin();
  const record = useCaseDetail(caseId);
  const [downloading, setDownloading] = useState(false);

  const detail = useDetailHandle(caseId);
  const run = useRunHandle(caseId);
  const quality = useQualityHandle(caseId);
  const metrics = useMetricsHandle(caseId);
  const coaching = useCoachingHandle(caseId);
  const forks = useForksHandle(caseId);
  const scenarios = useScenariosHandle(caseId);
  const warnings = useWarningsHandle(caseId);
  const ranking = useRankingHandle(caseId);
  const matches = useMatchesHandle(caseId);
  const timeline = useTimelineHandle(caseId);
  const claimReviews = useClaimReviewsHandle(caseId, true);

  const matchData = dataOf(sourceOf(matches));
  const shownMatchIds = (matchData ? deriveLearning(matchData).matches : [])
    .slice(0, REPORT_MATCHES_SHOWN)
    .map((match) => match.matchId);
  const overlayHandles = useOverlayHandles(caseId, shownMatchIds);

  const all: Handle<unknown>[] = [
    detail,
    run,
    quality,
    metrics,
    coaching,
    forks,
    scenarios,
    warnings,
    ranking,
    matches,
    timeline,
    claimReviews,
    ...Object.values(overlayHandles),
  ];
  const input: ReportInput = {
    detail: detail.source,
    run: run.source,
    quality: quality.source,
    metrics: metrics.source,
    coaching: coaching.source,
    forks: forks.source,
    scenarios: scenarios.source,
    warnings: warnings.source,
    ranking: ranking.source,
    matches: matches.source,
    overlays: Object.fromEntries(
      Object.entries(overlayHandles).map(([matchId, handle]) => [matchId, handle.source]),
    ),
    timeline: timeline.source,
    claimReviews: claimReviews.source,
    readAt: Math.max(0, ...all.map((handle) => handle.readAt)),
  };
  const overlaysPending = Object.values(overlayHandles).some(
    (handle) => handle.source.kind === 'loading',
  );
  const report = buildReport(input, role);
  const failedHandles = all.filter((handle) => handle.source.kind === 'failed');
  const data = record.data;

  const header = (
    <PageHeader
      title="Report"
      description={
        data
          ? `${data.reference} · ${data.title}`
          : 'The decision-ready report of the guided review.'
      }
      help={PAGE_HELP}
      meta={
        <>
          <ProvenanceBadge kind="estimated" />
          {data?.synthetic ? <ProvenanceBadge kind="synthetic" /> : null}
        </>
      }
      actions={
        <LinkButton
          href={caseHref(caseId, 'review')}
          appearance="outline"
          icon={<DocumentTextRegular />}
        >
          Back to the guided review
        </LinkButton>
      }
    />
  );

  if (record.isError && record.error.isNotFound) return <CaseNotFoundState />;
  if (auth.status === 'unauthenticated') {
    return (
      <>
        {header}
        <IdentityRequired />
      </>
    );
  }
  if (data !== undefined && data.analysisState !== 'analyzed') {
    return (
      <>
        {header}
        <NotAnalysedState caseId={caseId} subject="the report" analysisState={data.analysisState} />
      </>
    );
  }

  const pending = report.pending || overlaysPending;
  const reportUrl = `${origin}${caseHref(caseId, 'report')}`;

  const copy = async (): Promise<void> => {
    const ok = await copyText(reportSummary(report, reportUrl));
    if (ok)
      toast.success('Summary copied', { body: 'A short plain-text summary is on your clipboard.' });
    else
      toast.error('The summary could not be copied', {
        body: 'Select the text of the report and copy it.',
      });
  };

  const download = async (): Promise<void> => {
    setDownloading(true);
    try {
      const html = await buildReportHtml({ report, caseId, origin });
      downloadFile(html, report.fileName, 'text/html;charset=utf-8');
      toast.success('Report downloaded', {
        body: `${report.fileName} is one file with no scripts; it opens in any browser.`,
      });
    } catch {
      toast.error('The report could not be downloaded', { body: 'Try printing it instead.' });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <>
      {header}
      {/* The report's own stylesheet: a constant, so it is written as it is. */}
      <style dangerouslySetInnerHTML={{ __html: REPORT_CSS }} />
      <div className={`${styles.stack} cg-no-print`}>
        <div className={styles.toolbar} role="group" aria-label="Report actions">
          <Button
            appearance="primary"
            icon={<PrintRegular />}
            disabled={pending}
            onClick={() => window.print()}
          >
            Print
          </Button>
          <Button
            appearance="outline"
            icon={<CopyRegular />}
            disabled={pending}
            onClick={() => void copy()}
          >
            Copy summary
          </Button>
          <Button
            appearance="outline"
            icon={<ArrowDownloadRegular />}
            disabled={pending || downloading}
            onClick={() => void download()}
          >
            Download HTML
          </Button>
          <p className={styles.note}>
            To keep a PDF, choose Print and then “Save as PDF” in your browser.
          </p>
        </div>
        {failedHandles.length > 0 ? (
          <Notice variant="warning" compact title="Some parts could not be read">
            <p>
              {failedHandles.length === 1
                ? 'One part of the report could not be read and is left out.'
                : `${failedHandles.length} parts of the report could not be read and are left out.`}{' '}
              <Button
                appearance="outline"
                size="small"
                icon={<ArrowSyncRegular />}
                onClick={() => failedHandles.forEach((handle) => handle.retry())}
              >
                Try again
              </Button>
            </p>
          </Notice>
        ) : null}
      </div>
      {pending ? (
        <LoadingSkeleton variant="card" count={3} label="Preparing the report" />
      ) : (
        <ReportDocument report={report} caseId={caseId} origin={origin} embedded />
      )}
    </>
  );
}
