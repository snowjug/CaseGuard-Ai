'use client';

import { AGENT_LABELS, type ModelExecutionWithUsage } from '@caseguard/schemas';
import { UiLink, cg, formatProbability } from '@caseguard/ui';
import { CircleCheckIcon, CircleXIcon } from 'lucide-react';
import { FactList } from '../../lib/advanced-view-parts';
import { caseHref } from '../../lib/deep-links';
import { shortId } from '../../lib/format';
import { CHECK_LABELS, tokensText, usdText } from './model';
import { useUsageStyles } from './styles';

/** Everything recorded about one model call: how it ran, what the checks on its answer said, and its estimated usage. */
export function ExecutionDetails({ row }: { row: ModelExecutionWithUsage }) {
  const styles = useUsageStyles();
  const usage = row.usage;
  return (
    <div className={styles.stack}>
      <FactList
        label={`Details of the ${AGENT_LABELS[row.agent]} call`}
        items={[
          { id: 'attempts', label: 'Attempts', value: String(row.attempts) },
          ...(row.retries !== undefined
            ? [{ id: 'retries', label: 'Transport retries', value: String(row.retries) }]
            : []),
          ...(row.repairAttempts !== undefined
            ? [{ id: 'repairs', label: 'Repair attempts', value: String(row.repairAttempts) }]
            : []),
          { id: 'prompt', label: 'Prompt version', value: row.promptVersion },
          ...(row.fallbackReason
            ? [{ id: 'fallback', label: 'Why code answered instead', value: row.fallbackReason }]
            : []),
          ...(row.error ? [{ id: 'error', label: 'Error', value: row.error }] : []),
          ...(row.caseId
            ? [
                {
                  id: 'case',
                  label: 'Case',
                  value: (
                    <UiLink href={caseHref(row.caseId)} className={styles.link}>
                      Open the case
                    </UiLink>
                  ),
                },
              ]
            : []),
          ...(row.inputHash
            ? [{ id: 'hash', label: 'Input hash', value: shortId(row.inputHash, 16), mono: true }]
            : []),
        ]}
      />
      <h3 className={styles.subhead}>Checks on the answer</h3>
      <ul className={styles.checks}>
        {CHECK_LABELS.map(([key, label]) => (
          <li key={key} className={styles.check}>
            {row.validation[key] ? (
              <CircleCheckIcon aria-hidden="true" style={{ color: cg.tone.productive.fg }} />
            ) : (
              <CircleXIcon aria-hidden="true" style={{ color: cg.tone.unsupported.fg }} />
            )}
            <span>
              {label}: {row.validation[key] ? 'passed' : 'failed'}
            </span>
          </li>
        ))}
      </ul>
      {row.validation.issues.length > 0 ? (
        <ul className={styles.bullets} aria-label="Issues found by the checks">
          {row.validation.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}
      {usage ? (
        <>
          <h3 className={styles.subhead}>Token usage (estimated)</h3>
          <FactList
            label="Token usage of this call"
            items={[
              {
                id: 'before',
                label: 'Context before',
                value: `${tokensText(usage.contextTokensBefore)} tokens`,
              },
              {
                id: 'after',
                label: 'Context after',
                value: `${tokensText(usage.contextTokensAfter)} tokens`,
              },
              {
                id: 'ratio',
                label: 'Compression',
                value: formatProbability(usage.compressionRatio, 0),
              },
              { id: 'cache', label: 'Cache', value: usage.cacheHit ? 'Hit' : 'Miss' },
              { id: 'early', label: 'Stopped early', value: usage.earlyStopped ? 'Yes' : 'No' },
              {
                id: 'saved',
                label: 'Estimated tokens saved',
                value: tokensText(usage.estimatedSavingsTokens),
              },
              {
                id: 'cost',
                label: 'Estimated cost',
                value: usdText(usage.estimatedCostUsd, 'Unknown'),
              },
              {
                id: 'impact',
                label: 'Estimated effect on quality',
                value: usage.estimatedQualityImpact.note,
                hint: usage.estimatedQualityImpact.level.replace('_', ' '),
              },
              ...(usage.tokenSource
                ? [{ id: 'source', label: 'Token counts', value: usage.tokenSource }]
                : []),
            ]}
          />
        </>
      ) : null}
    </div>
  );
}
