'use client';

import {
  OPEN_WARNING_DEFINITION,
  WARNING_CATEGORY_LABELS,
  type CaseWarning,
} from '@caseguard/schemas';
import { EmptyState, Panel, StatusBadge, UiLink, formatRelativeTime } from '@caseguard/ui';
import { Button } from '@fluentui/react-components';
import { CheckmarkCircleRegular } from '@fluentui/react-icons';
import { useMemo, useState } from 'react';
import { caseHref, evidenceLinkHref, evidenceLinkLabel } from '../../lib/deep-links';
import { PRIORITY_BADGES } from '../../lib/labels';
import { usePanelStyles } from './panel-styles';

const INITIAL_COUNT = 4;

export interface WarningsPanelProps {
  warnings: readonly CaseWarning[];
  /** The instant the data was generated: relative times are measured against it, never against the local clock. */
  generatedAt: string;
  /** Case whose quality review the footer link opens. */
  caseId: string | null;
}

/** Open warnings, most important first. Each one is specific, says what to do next and links to its evidence. */
export function WarningsPanel({ warnings, generatedAt, caseId }: WarningsPanelProps) {
  const styles = usePanelStyles();
  const [expanded, setExpanded] = useState(false);
  const ordered = useMemo(() => [...warnings].sort((a, b) => a.rank - b.rank), [warnings]);
  const visible = expanded ? ordered : ordered.slice(0, INITIAL_COUNT);
  const now = new Date(generatedAt);
  const reviewCase = caseId ?? ordered[0]?.caseId ?? null;

  return (
    <Panel
      title="Open warnings"
      description="Highest priority first. Each warning names the evidence it is based on."
      help={OPEN_WARNING_DEFINITION}
      footer={
        reviewCase ? (
          <UiLink href={caseHref(reviewCase, 'quality')} className={styles.link}>
            Open the quality review
          </UiLink>
        ) : undefined
      }
    >
      {ordered.length === 0 ? (
        <EmptyState
          compact
          headingLevel={3}
          icon={<CheckmarkCircleRegular />}
          title="No open warnings"
          description="Nothing needs attention right now. Warnings appear when the evidence shows a delay, a missing item or an unsupported step."
        />
      ) : (
        <>
          <ul className={styles.list}>
            {visible.map((warning) => {
              const priority = PRIORITY_BADGES[warning.priority];
              return (
                <li key={warning.id} className={styles.item}>
                  <div className={styles.itemHead}>
                    <StatusBadge status={priority.status} label={priority.label} size="small" />
                    <span className={styles.meta}>{WARNING_CATEGORY_LABELS[warning.category]}</span>
                  </div>
                  <h3 className={styles.itemTitle}>{warning.title}</h3>
                  <p className={styles.itemText}>{warning.message}</p>
                  <p className={styles.itemText}>
                    <strong>Next step:</strong> {warning.suggestedAction}
                  </p>
                  {warning.evidence.length > 0 ? (
                    <ul className={styles.chips} aria-label="Evidence for this warning">
                      {warning.evidence.map((link) => (
                        <li key={`${link.type}:${link.id}`}>
                          <UiLink
                            href={evidenceLinkHref(warning.caseId, link)}
                            className={styles.chip}
                          >
                            {evidenceLinkLabel(link)}
                          </UiLink>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <p className={styles.meta}>Raised {formatRelativeTime(warning.raisedAt, now)}</p>
                </li>
              );
            })}
          </ul>
          {ordered.length > INITIAL_COUNT ? (
            <Button
              appearance="subtle"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? 'Show fewer' : `Show all ${ordered.length} warnings`}
            </Button>
          ) : null}
        </>
      )}
    </Panel>
  );
}
