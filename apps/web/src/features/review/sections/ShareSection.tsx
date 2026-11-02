'use client';

import { Notice, ProvenanceBadge, cg, copyText } from '@caseguard/ui';
import { Button, makeStyles, tokens } from '@fluentui/react-components';
import { CopyRegular, DocumentTextRegular } from '@fluentui/react-icons';
import { useMemo } from 'react';
import { LinkButton } from '../../../components/common/LinkButton';
import { caseHref } from '../../../lib/deep-links';
import { useToast } from '../../../lib/toast';
import {
  useCoachingHandle,
  useDetailHandle,
  useForksHandle,
  useMetricsHandle,
  useQualityHandle,
  useRankingHandle,
  useWarningsHandle,
} from '../hooks';
import { deriveNextActions } from '../model/actions';
import { shareSummary } from '../model/summary';
import { deriveMissedMoment, deriveVerdict } from '../model/verdict';
import { SectionFrame } from './shared';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[3], minWidth: 0 },
  text: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
  },
  actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
});

/** What the short summary could not include, in words, for the reader of the summary. */
function missingParts(kinds: Record<string, string>): string[] {
  return Object.entries(kinds).map(([part, why]) => `${part} (${why})`);
}

/**
 * Share: the link to the decision-ready report (the one primary action of the page) and a button that copies a short plain
 * text summary. The summary is built from what this role can read and names what it left out.
 */
export function ShareSection({ caseId }: { caseId: string }) {
  const styles = useStyles();
  const toast = useToast();
  const detail = useDetailHandle(caseId);
  const quality = useQualityHandle(caseId);
  const coaching = useCoachingHandle(caseId);
  const metrics = useMetricsHandle(caseId);
  const forks = useForksHandle(caseId);
  const warnings = useWarningsHandle(caseId);
  const ranking = useRankingHandle(caseId);

  const detailData = detail.source.kind === 'ready' ? detail.source.data : null;
  const qualityData = quality.source.kind === 'ready' ? quality.source.data : null;
  const coachingData = coaching.source.kind === 'ready' ? coaching.source.data : null;
  const metricsData = metrics.source.kind === 'ready' ? metrics.source.data : null;
  const forksData = forks.source.kind === 'ready' ? forks.source.data : null;
  const warningsData = warnings.source.kind === 'ready' ? warnings.source.data : null;
  const rankingData = ranking.source.kind === 'ready' ? ranking.source.data : null;

  const text = useMemo(
    () =>
      (origin: string): string | null => {
        if (!detailData) return null;
        const left: Record<string, string> = {};
        if (quality.source.kind !== 'ready')
          left['the case quality result'] =
            quality.source.kind === 'denied' ? 'your role cannot read it' : 'it could not be read';
        if (forks.source.kind !== 'ready')
          left['the decision points'] =
            forks.source.kind === 'denied'
              ? 'your role cannot read them'
              : 'they could not be read';
        return shareSummary({
          reference: detailData.reference,
          title: detailData.title,
          synthetic: detailData.synthetic,
          verdict: qualityData
            ? deriveVerdict({
                quality: qualityData,
                coaching: coachingData,
                forks: forksData,
                detail: detailData,
                metrics: metricsData,
              })
            : null,
          missed: forksData ? deriveMissedMoment(forksData) : undefined,
          actions: deriveNextActions({
            quality: qualityData,
            warnings: warningsData,
            coaching: coachingData,
            ranking: rankingData,
          }),
          reportUrl: `${origin}${caseHref(caseId, 'report')}`,
          notIncluded: missingParts(left),
        });
      },
    [
      detailData,
      qualityData,
      coachingData,
      metricsData,
      forksData,
      warningsData,
      rankingData,
      quality.source.kind,
      forks.source.kind,
      caseId,
    ],
  );

  const copy = async (): Promise<void> => {
    const summary = text(window.location.origin);
    if (!summary) return;
    const ok = await copyText(summary);
    if (ok)
      toast.success('Summary copied', { body: 'A short plain-text summary is on your clipboard.' });
    else
      toast.error('The summary could not be copied', {
        body: 'Open the report and copy it from there.',
      });
  };

  return (
    <SectionFrame
      id="share"
      title="Share"
      description="Hand the result to someone who was not in the case."
      badges={<ProvenanceBadge kind="estimated" />}
    >
      <div className={styles.stack}>
        <p className={styles.text}>
          The report puts the verdict, the chronology, the missed moment, the recorded and
          better-supported paths, the recommendations with their evidence, what was learned, how it
          was calculated and who reviewed what on one page that reads well on screen, prints and
          downloads as a single file.
        </p>
        <div className={styles.actions}>
          <LinkButton
            href={caseHref(caseId, 'report')}
            appearance="primary"
            icon={<DocumentTextRegular />}
          >
            Open the report
          </LinkButton>
          <Button
            appearance="outline"
            icon={<CopyRegular />}
            disabled={!detailData}
            onClick={() => void copy()}
          >
            Copy summary
          </Button>
        </div>
        <Notice variant="info" compact title="About the figures">
          Everything shared from here is an estimate or a simulation, and says so. Nothing in it
          rates a person.
        </Notice>
      </div>
    </SectionFrame>
  );
}
