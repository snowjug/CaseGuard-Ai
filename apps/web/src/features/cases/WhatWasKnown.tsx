'use client';

import { Accordion, AccordionItem, Badge, Card, cg, formatDateTimeUtc } from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';
import { HistoryIcon } from 'lucide-react';
import { AsOfPanel, type AsOfPanelProps } from '../../components/case/AsOfPanel';

const useStyles = makeStyles({
  bar: { paddingBlock: 0, paddingInline: cg.space[4] },
});

/**
 * The time cursor, folded away: "what was known then" replays the case as it stood at an earlier moment, which is a
 * power feature and not the first thing a reader needs. It opens by itself when the address already names a moment (the
 * other pages link here with one), and its closed bar always says which moment is shown.
 */
export function WhatWasKnown(props: AsOfPanelProps) {
  const styles = useStyles();
  const { asOf, known } = props;
  const cut = known?.cutAt ? formatDateTimeUtc(known.cutAt) : null;
  const subtitle =
    asOf === null
      ? 'Showing the whole record, up to the last event.'
      : cut
        ? `Showing the case as of ${cut}.`
        : 'Showing an earlier moment.';
  return (
    <Card padding="none" className={styles.bar}>
      <Accordion>
        <AccordionItem
          title="What was known then"
          subtitle={subtitle}
          icon={<HistoryIcon />}
          badge={
            asOf === null ? null : (
              <Badge tone="brand" size="sm">
                Earlier moment
              </Badge>
            )
          }
          headingLevel={2}
          defaultOpen={asOf !== null}
        >
          <AsOfPanel {...props} />
        </AccordionItem>
      </Accordion>
    </Card>
  );
}
