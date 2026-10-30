'use client';

import type { CounterfactualScenario, DecisionFork } from '@caseguard/schemas';
import {
  BadgeShell,
  KeyValueList,
  LoadingSkeleton,
  Notice,
  ProvenanceBadge,
  StatusBadge,
  cg,
  formatDateTimeUtc,
  formatDuration,
  formatNumber,
  formatProbability,
} from '@caseguard/ui';
import { Button, makeStyles, tokens } from '@fluentui/react-components';
import { EyeRegular, EyeOffRegular, LockClosedRegular } from '@fluentui/react-icons';
import { useState } from 'react';
import { QueryErrorState } from '../../components/common/QueryErrorState';
import { isApiError } from '../../lib/api/errors';
import { useSession } from '../../lib/auth/session';
import { useHindsightQuery } from './hooks';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    minWidth: 0,
    padding: cg.space[4],
    borderRadius: cg.radius.lg,
    border: `2px dashed ${cg.tone.uncertain.border}`,
    backgroundColor: cg.surfaceSunken,
    color: cg.text,
  },
  head: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  h2: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
  },
  text: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
    overflowWrap: 'anywhere',
  },
  muted: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  body: { display: 'flex', flexDirection: 'column', gap: cg.space[3] },
});

export interface HindsightPanelProps {
  caseId: string;
  fork: DecisionFork;
  scenario: CounterfactualScenario | null;
}

/**
 * Hindsight, kept visibly and structurally apart from everything that generated the path: it uses the final resolution
 * of the case, was computed afterwards and is only requested when a person who may see it asks. Callers without the
 * permission see why it is unavailable; a 403 from the API is handled the same way.
 */
export function HindsightPanel({ caseId, fork, scenario }: HindsightPanelProps) {
  const styles = useStyles();
  const { can, isLoading } = useSession();
  const entitled = can('quality:review');
  const [shown, setShown] = useState(false);
  const query = useHindsightQuery(caseId, scenario?.id ?? null, shown && entitled);
  const check = query.data;
  const forbidden = isApiError(query.error) && query.error.isForbidden;

  return (
    <section className={styles.root} aria-labelledby="hindsight-heading">
      <div className={styles.head}>
        <BadgeShell
          tone="uncertain"
          pattern="dots"
          icon={<EyeRegular />}
          label="Hindsight"
          size="medium"
        />
        <h2 id="hindsight-heading" className={styles.h2}>
          Hindsight (not used to generate)
        </h2>
      </div>
      <Notice variant="warning" compact title="Uses the final resolution">
        Everything above this panel was produced and checked without the final outcome. This check
        compares the simulated path with how the case actually ended, after the fact. It never feeds
        generation, detection or warnings.
      </Notice>

      {!entitled && !isLoading ? (
        <p className={styles.text}>
          <LockClosedRegular aria-hidden="true" /> Hindsight is limited to people who review quality
          (Support Quality Reviewer or Administrator). Your role does not include it, so nothing
          from the recorded outcome is loaded.
        </p>
      ) : scenario === null ? (
        <p className={styles.text}>
          Generate a simulated path for this fork first: hindsight evaluates a path.
        </p>
      ) : (
        <>
          <div>
            <Button
              appearance="outline"
              icon={shown ? <EyeOffRegular /> : <EyeRegular />}
              aria-expanded={shown}
              disabled={isLoading}
              onClick={() => setShown((value) => !value)}
            >
              {shown ? 'Hide the hindsight check' : 'Show the hindsight check'}
            </Button>
          </div>
          {shown ? (
            <div className={styles.body} aria-live="polite">
              {query.isPending ? (
                <LoadingSkeleton variant="card" count={1} label="Loading the hindsight check" />
              ) : query.isError ? (
                forbidden ? (
                  <Notice variant="info" title="Not available to your role">
                    The API refused the hindsight check for your role. It is limited to people who
                    review quality.
                  </Notice>
                ) : (
                  <QueryErrorState
                    compact
                    subject="The hindsight check"
                    error={query.error}
                    onRetry={() => void query.refetch()}
                    retrying={query.isFetching}
                  />
                )
              ) : check ? (
                <>
                  <div className={styles.head}>
                    <ProvenanceBadge kind="simulated" />
                    <ProvenanceBadge kind="estimated" />
                    <span className={styles.muted}>
                      Computed {formatDateTimeUtc(check.computedAt)}
                    </span>
                  </div>
                  <p className={styles.text}>{check.notice}</p>
                  <KeyValueList
                    columns={2}
                    items={[
                      {
                        label: 'Recorded root cause (hypothesis)',
                        value: check.resolutionHypothesisKey ?? 'Not recorded',
                        mono: check.resolutionHypothesisKey !== null,
                      },
                      {
                        label: 'Leading hypothesis at the end of the simulated path',
                        value: check.leadingHypothesisAtEndOfPath
                          ? `${check.leadingHypothesisAtEndOfPath.name} (${formatProbability(check.leadingHypothesisAtEndOfPath.confidence)}, simulated)`
                          : 'None',
                      },
                      {
                        label: 'Consistent with the recorded resolution',
                        value:
                          check.consistentWithResolution === null ? (
                            <StatusBadge status="missing" label="Cannot be judged" size="small" />
                          ) : check.consistentWithResolution ? (
                            <StatusBadge status="productive" label="Consistent" size="small" />
                          ) : (
                            <StatusBadge status="unsupported" label="Not consistent" size="small" />
                          ),
                      },
                      {
                        label: 'Time to diagnosis',
                        value: `${
                          check.simulatedTimeToDiagnosisMinutes
                            ? `${formatDuration(check.simulatedTimeToDiagnosisMinutes.mid)} simulated (range ${formatDuration(check.simulatedTimeToDiagnosisMinutes.low)} to ${formatDuration(check.simulatedTimeToDiagnosisMinutes.high)})`
                            : 'no simulated diagnosis'
                        } versus ${
                          check.actualTimeToDiagnosisMinutes === null
                            ? 'no recorded diagnosis'
                            : `${formatDuration(check.actualTimeToDiagnosisMinutes)} recorded`
                        }`,
                      },
                    ]}
                  />
                  <p className={styles.text}>{check.explanation}</p>
                </>
              ) : null}
              {fork.retrospective ? (
                <div>
                  <p className={styles.text}>
                    <strong>What the recorded step eventually produced:</strong>{' '}
                    {formatNumber(fork.retrospective.realizedInformationGainBits, {
                      maximumFractionDigits: 2,
                    })}{' '}
                    bits of information. {fork.retrospective.outcomeSummary}
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
