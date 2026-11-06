'use client';

import type { MissingEvidence } from '@caseguard/schemas';
import { AccordionItem, Badge, StatusBadge, cg, formatDateTimeUtc } from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { CircleHelpIcon } from 'lucide-react';
import { countOf } from '../../components/case/labels';
import { CRITICALITY_LABELS } from '../../lib/labels';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[3], minWidth: 0 },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  item: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    minWidth: 0,
    paddingLeft: cg.space[3],
    borderLeft: `2px solid ${cg.borderSubtle}`,
  },
  head: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    overflowWrap: 'anywhere',
  },
  text: {
    margin: 0,
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase300,
    overflowWrap: 'anywhere',
  },
  note: {
    margin: 0,
    color: cg.textMuted,
    fontSize: tokens.fontSizeBase200,
    overflowWrap: 'anywhere',
  },
  intro: { margin: 0, color: cg.textSecondary, fontSize: tokens.fontSizeBase200 },
});

const CRITICALITY_ORDER: Record<MissingEvidence['criticality'], number> = {
  critical: 0,
  important: 1,
  helpful: 2,
};

/** Open requirements first, most critical first, then by when they became relevant. */
export function sortMissing(items: readonly MissingEvidence[]): MissingEvidence[] {
  return [...items].sort(
    (a, b) =>
      Number(a.resolvedAt !== null) - Number(b.resolvedAt !== null) ||
      CRITICALITY_ORDER[a.criticality] - CRITICALITY_ORDER[b.criticality] ||
      Date.parse(a.firstRelevantAt) - Date.parse(b.firstRelevantAt),
  );
}

export interface MissingEvidencePanelProps {
  items: readonly MissingEvidence[];
  asOf: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * What the knowledge pack says the investigation needed, and whether it was collected. With a time cursor the API lists
 * only requirements that had become relevant by then, and "collected" only if it had been by then. One collapsed row of
 * the coverage card; the page opens it from the "still missing" figure.
 */
export function MissingEvidencePanel({
  items,
  asOf,
  open,
  onOpenChange,
}: MissingEvidencePanelProps) {
  const styles = useStyles();
  const sorted = sortMissing(items);
  const stillOpen = sorted.filter((item) => item.resolvedAt === null).length;
  return (
    <AccordionItem
      title="What is still missing"
      subtitle={
        items.length === 0
          ? 'No evidence requirements apply yet.'
          : `${countOf(stillOpen, 'requirement')} still open of ${items.length}${asOf ? ' at this moment' : ''}.`
      }
      icon={<CircleHelpIcon />}
      headingLevel={3}
      open={open}
      onOpenChange={onOpenChange}
    >
      {items.length === 0 ? (
        <p className={styles.intro}>Nothing is required at this point in the case.</p>
      ) : (
        <div className={styles.stack}>
          <p className={styles.intro}>
            Each requirement comes from the workload&rsquo;s knowledge pack: evidence a careful
            investigation would collect, and the question to ask for it. Critical requirements
            should be met before a root cause is claimed.
          </p>
          <ul className={styles.list} aria-label="Evidence requirements">
            {sorted.map((item) => (
              <li key={item.id} className={styles.item}>
                <div className={styles.head}>
                  {item.resolvedAt ? (
                    <>
                      <StatusBadge status="productive" size="small" label="Collected" />
                      <Badge tone="neutral" size="sm" outlined>
                        {CRITICALITY_LABELS[item.criticality]}
                      </Badge>
                    </>
                  ) : (
                    <>
                      <StatusBadge status="missing" size="small" label="Still needed" />
                      <StatusBadge
                        status={item.criticality === 'critical' ? 'unsupported' : 'uncertain'}
                        size="small"
                        label={CRITICALITY_LABELS[item.criticality]}
                      />
                    </>
                  )}
                  <h4 className={styles.title}>{item.label}</h4>
                </div>
                <p className={styles.text}>{item.description}</p>
                <p className={styles.note}>
                  Relevant from {formatDateTimeUtc(item.firstRelevantAt)}
                  {item.resolvedAt
                    ? `; collected ${formatDateTimeUtc(item.resolvedAt)}${
                        item.resolvedByEventId ? ` in event ${item.resolvedByEventId}` : ''
                      }`
                    : ''}
                  .
                </p>
                {!item.resolvedAt ? (
                  <p className={styles.note}>Suggested ask: {item.askText}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </AccordionItem>
  );
}
