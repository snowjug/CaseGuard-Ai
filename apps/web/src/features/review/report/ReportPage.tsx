'use client';

import {
  Button,
  Card,
  Notice,
  PageHeader,
  ProvenanceBadge,
  Skeleton,
  VisuallyHidden,
  cg,
  copyText,
} from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { CopyIcon, DownloadIcon, PrinterIcon, RotateCwIcon } from 'lucide-react';
import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { useCaseDetail } from '../../../components/case/case-hooks';
import { CaseNotFoundState } from '../../../components/case/CaseNotFoundState';
import { NotAnalysedState } from '../../../components/case/NotAnalysedState';
import { IdentityRequired } from '../../../components/common/IdentityRequired';
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
  actions: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: cg.space[2],
    '@media (min-width: 640px)': { alignItems: 'flex-end' },
  },
  toolbar: { display: 'flex', flexWrap: 'wrap', gap: cg.space[2] },
  hint: {
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    color: cg.textSecondary,
    '@media (min-width: 640px)': { textAlign: 'end' },
  },
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    minWidth: 0,
    marginBottom: cg.space[4],
  },
  placeholder: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[4],
    maxWidth: '880px',
    marginInline: 'auto',
  },
  placeholderHead: { gap: cg.space[3] },
  placeholderRow: { display: 'flex', flexWrap: 'wrap', gap: cg.space[2] },
  placeholderLines: { display: 'flex', flexDirection: 'column', gap: cg.space[2] },
});

const PAGE_HELP = (
  <>
    <p>
      The review on one page: the verdict, the chronology, the earliest missed moment, the recorded
      and the better-supported path, the recommendations with their evidence, what was learned, how
      it was calculated and who reviewed what.
    </p>
    <p>
      It is built from the same figures as the review. A section your role may not read is left out,
      and the report says so. Print it, copy a short summary, or download it as one HTML file that
      opens anywhere without a script.
    </p>
  </>
);

/** Same footprint as the document (title block, then section cards), so nothing jumps when it appears. */
function ReportSkeleton() {
  const styles = useStyles();
  return (
    <div role="status" aria-busy="true" aria-live="polite" className={styles.placeholder}>
      <VisuallyHidden>Preparing the report…</VisuallyHidden>
      <Card aria-hidden="true" className={styles.placeholderHead}>
        <Skeleton width={190} height={12} />
        <Skeleton width="72%" height={28} />
        <div className={styles.placeholderRow}>
          <Skeleton width={92} height={22} radius="pill" />
          <Skeleton width={168} height={22} radius="pill" />
          <Skeleton width={104} height={22} radius="pill" />
        </div>
        <div className={styles.placeholderLines}>
          <Skeleton width="48%" height={14} />
          <Skeleton width="40%" height={14} />
          <Skeleton width="44%" height={14} />
        </div>
      </Card>
      {[0, 1].map((index) => (
        <Card key={index} aria-hidden="true" className={styles.placeholderHead}>
          <Skeleton width="34%" height={20} />
          <Skeleton height={14} />
          <Skeleton width="92%" height={14} />
          <Skeleton width="64%" height={14} />
        </Card>
      ))}
    </div>
  );
}

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

  const header = (actions?: ReactNode) => (
    <PageHeader
      title="Report"
      description="Share the review as one document."
      help={PAGE_HELP}
      meta={
        <>
          <ProvenanceBadge kind="estimated" />
          {data?.synthetic ? <ProvenanceBadge kind="synthetic" /> : null}
        </>
      }
      {...(actions ? { actions } : {})}
    />
  );

  if (record.isError && record.error.isNotFound) return <CaseNotFoundState />;
  if (auth.status === 'unauthenticated') {
    return (
      <>
        {header()}
        <IdentityRequired />
      </>
    );
  }
  if (data !== undefined && data.analysisState !== 'analyzed') {
    return (
      <>
        {header()}
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

  // The toolbar is for the screen only: the print rules hide it with the rest of the page around the document.
  const toolbar = (
    <div className={mergeClasses(styles.actions, 'cg-no-print')}>
      <div className={styles.toolbar} role="group" aria-label="Report actions">
        <Button
          variant="primary"
          icon={<PrinterIcon />}
          disabled={pending}
          onClick={() => window.print()}
        >
          Print
        </Button>
        <Button
          variant="secondary"
          icon={<CopyIcon />}
          disabled={pending}
          onClick={() => void copy()}
        >
          Copy summary
        </Button>
        <Button
          variant="secondary"
          icon={<DownloadIcon />}
          disabled={pending}
          loading={downloading}
          onClick={() => void download()}
        >
          Download HTML
        </Button>
      </div>
      <p className={styles.hint}>
        To keep a PDF, choose Print and then “Save as PDF” in your browser.
      </p>
    </div>
  );

  return (
    <>
      {header(toolbar)}
      {/* The report's own stylesheet: a constant, so it is written as it is. */}
      <style dangerouslySetInnerHTML={{ __html: REPORT_CSS }} />
      {failedHandles.length > 0 ? (
        <div className={`${styles.stack} cg-no-print`}>
          <Notice
            variant="warning"
            compact
            title="Some parts could not be read"
            action={
              <Button
                variant="secondary"
                size="sm"
                icon={<RotateCwIcon />}
                onClick={() => failedHandles.forEach((handle) => handle.retry())}
              >
                Try again
              </Button>
            }
          >
            {failedHandles.length === 1
              ? 'One part of the report could not be read and is left out.'
              : `${failedHandles.length} parts of the report could not be read and are left out.`}
          </Notice>
        </div>
      ) : null}
      {pending ? (
        <ReportSkeleton />
      ) : (
        <ReportDocument report={report} caseId={caseId} origin={origin} embedded />
      )}
    </>
  );
}
