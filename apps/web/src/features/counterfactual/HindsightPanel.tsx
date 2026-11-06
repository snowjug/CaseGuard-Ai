'use client';

import type { CounterfactualScenario, DecisionFork } from '@caseguard/schemas';
import {
  AccordionItem,
  KeyValueList,
  LoadingSkeleton,
  ProvenanceBadge,
  StatusBadge,
  cg,
  formatDuration,
  formatNumber,
  formatProbability,
  RelativeTime,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { EyeIcon, LockIcon } from 'lucide-react';
import { useState } from 'react';
import { QueryErrorState } from '../../components/common/QueryErrorState';
import { isApiError } from '../../lib/api/errors';
import { useSession } from '../../lib/auth/session';
import { useHindsightQuery } from './hooks';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[3], minWidth: 0 },
  head: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  text: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
    overflowWrap: 'anywhere',
  },
  muted: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  lock: { display: 'inline-flex', verticalAlign: 'middle', marginInlineEnd: cg.space[1] },
});

export interface HindsightPanelProps {
  caseId: string;
  fork: DecisionFork;
  scenario: CounterfactualScenario | null;
}

/**
 * Hindsight ("known only later"), kept visibly and structurally apart from everything that generated the path: it uses the
 * final resolution of the case, was computed afterwards and is only requested when a person who may see it opens it.
 * Callers without the permission see why it is unavailable and nothing is loaded; a 403 from the API is handled the same way.
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
    <AccordionItem
      title="Known only later"
      subtitle="Hindsight: uses the final resolution and is never used to generate a path"
      icon={<EyeIcon />}
      headingLevel={2}
      open={shown}
      onOpenChange={setShown}
    >
      <div className={styles.stack}>
        <p className={styles.text}>
          <strong>Uses the final resolution.</strong> Everything above was produced and checked
          without the final outcome. This check compares the simulated path with how the case
          actually ended, after the fact. It never feeds generation, detection or warnings.
        </p>
        {!entitled && !isLoading ? (
          <p className={styles.text}>
            <LockIcon aria-hidden="true" className={styles.lock} /> Hindsight is limited to people
            who review quality (Support Quality Reviewer or Administrator). Your role does not
            include it, so nothing from the recorded outcome is loaded.
          </p>
        ) : scenario === null ? (
          <p className={styles.text}>
            Generate a simulated path for this key decision first: hindsight evaluates a path.
          </p>
        ) : (
          <div className={styles.stack} aria-live="polite">
            {query.isPending ? (
              <LoadingSkeleton variant="card" count={1} label="Loading the hindsight check" />
            ) : query.isError ? (
              forbidden ? (
                <p className={styles.text}>
                  <strong>Not available to your role.</strong> The API refused the hindsight check
                  for your role. It is limited to people who review quality.
                </p>
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
                    Computed <RelativeTime value={check.computedAt} />
                  </span>
                </div>
                <p className={styles.text}>{check.notice}</p>
                <KeyValueList
                  columns={2}
                  items={[
                    {
                      label: 'Recorded root cause',
                      value: check.resolutionHypothesisKey ?? 'Not recorded',
                      mono: check.resolutionHypothesisKey !== null,
                    },
                    {
                      label: 'Leading possible cause at the end of the simulated path',
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
              <p className={styles.text}>
                <strong>What the recorded step eventually produced:</strong>{' '}
                {formatNumber(fork.retrospective.realizedInformationGainBits, {
                  maximumFractionDigits: 2,
                })}{' '}
                bits of information. {fork.retrospective.outcomeSummary}
              </p>
            ) : null}
          </div>
        )}
      </div>
    </AccordionItem>
  );
}
