'use client';

import type { CaseSummary } from '@caseguard/schemas';
import {
  EmptyState,
  Panel,
  ProvenanceBadge,
  StatusBadge,
  UiLink,
  formatNumber,
} from '@caseguard/ui';
import { FolderRegular } from '@fluentui/react-icons';
import { LinkButton } from '../../components/common/LinkButton';
import { caseHref } from '../../lib/deep-links';
import { ANALYSIS_STATE_BADGES, CASE_STATUS_LABELS, SEVERITY_LABELS } from '../../lib/labels';
import { usePanelStyles } from './panel-styles';

const quality = (value: number | null): string =>
  value === null
    ? 'Quality not available'
    : `Quality ${formatNumber(value, { maximumFractionDigits: 0 })}`;

/** The most recent cases as a compact list: it stays readable in a half-width panel, where a four-column table would not. */
export function RecentCasesPanel({ cases }: { cases: readonly CaseSummary[] }) {
  const styles = usePanelStyles();
  return (
    <Panel
      title="Recent cases"
      description="Open one to see its timeline, evidence and hypotheses."
      footer={
        <UiLink href="/cases" className={styles.link}>
          All cases
        </UiLink>
      }
    >
      {cases.length === 0 ? (
        <EmptyState
          compact
          headingLevel={3}
          icon={<FolderRegular />}
          title="No cases yet"
          description="Load the synthetic sample from Cases to see CaseGuard analyse a real-looking investigation."
          action={
            <LinkButton href="/cases" appearance="primary">
              Open Cases
            </LinkButton>
          }
        />
      ) : (
        <ul className={styles.list}>
          {cases.map((item) => {
            const analysis = ANALYSIS_STATE_BADGES[item.analysisState];
            return (
              <li key={item.id} className={styles.item}>
                <div className={styles.itemHead}>
                  <UiLink href={caseHref(item.id)} className={styles.link}>
                    {item.reference}
                  </UiLink>
                  <StatusBadge status={analysis.status} label={analysis.label} size="small" />
                  {item.synthetic ? <ProvenanceBadge kind="synthetic" /> : null}
                </div>
                <p className={styles.itemText}>{item.title}</p>
                <p className={styles.meta}>
                  {SEVERITY_LABELS[item.severity]} · {CASE_STATUS_LABELS[item.status]} ·{' '}
                  {quality(item.qualityIndex)} · {item.openWarningCount} open{' '}
                  {item.openWarningCount === 1 ? 'warning' : 'warnings'}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
