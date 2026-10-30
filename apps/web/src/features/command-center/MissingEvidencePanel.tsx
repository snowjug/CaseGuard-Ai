'use client';

import {
  CRITICAL_MISSING_EVIDENCE_DEFINITION,
  WARNING_CATEGORY_LABELS,
  type CommandCenter,
} from '@caseguard/schemas';
import {
  CopyButton,
  EmptyState,
  Panel,
  StatusBadge,
  UiLink,
  formatDateTimeUtc,
} from '@caseguard/ui';
import { CheckmarkCircleRegular } from '@fluentui/react-icons';
import { evidenceLinkHref } from '../../lib/deep-links';
import { CRITICALITY_LABELS } from '../../lib/labels';
import { usePanelStyles } from './panel-styles';

export interface MissingEvidencePanelProps {
  items: CommandCenter['criticalMissingEvidence'];
}

/** Evidence the knowledge pack calls critical for this stage that has not been collected, with the question to ask. */
export function MissingEvidencePanel({ items }: MissingEvidencePanelProps) {
  const styles = usePanelStyles();
  const open = items.filter((item) => item.resolvedAt === null);
  return (
    <Panel
      title="Critical missing evidence"
      description="What the investigation still needs, and the question that would get it."
      help={CRITICAL_MISSING_EVIDENCE_DEFINITION}
      accent="missing"
    >
      {open.length === 0 ? (
        <EmptyState
          compact
          headingLevel={3}
          icon={<CheckmarkCircleRegular />}
          title="Nothing critical is missing"
          description="Every item the knowledge pack marks as critical for this stage has been collected."
        />
      ) : (
        <ul className={styles.list}>
          {open.map((item) => (
            <li key={item.id} className={styles.item}>
              <div className={styles.itemHead}>
                <StatusBadge
                  status="missing"
                  label={`${CRITICALITY_LABELS[item.criticality]} · missing`}
                  size="small"
                />
                <span className={styles.meta}>{WARNING_CATEGORY_LABELS[item.category]}</span>
              </div>
              <h3 className={styles.itemTitle}>
                <UiLink
                  href={evidenceLinkHref(item.caseId, { type: 'requirement', id: item.id })}
                  className={styles.link}
                >
                  {item.label}
                </UiLink>
              </h3>
              <p className={styles.itemText}>{item.description}</p>
              {item.neededFor.length > 0 ? (
                <p className={styles.meta}>Needed for: {item.neededFor.join(', ')}</p>
              ) : null}
              <p className={styles.itemText}>
                <strong>Ask:</strong> {item.askText}{' '}
                <CopyButton value={item.askText} label={`Copy the question for ${item.label}`} />
              </p>
              <p className={styles.meta}>
                Relevant since {formatDateTimeUtc(item.firstRelevantAt)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
