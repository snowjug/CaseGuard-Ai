'use client';

import { Badge, Button, cg } from '@caseguard/ui';
import {
  Popover,
  PopoverSurface,
  PopoverTrigger,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ListFilterIcon } from 'lucide-react';
import type { ReactNode } from 'react';

const useStyles = makeStyles({
  surface: {
    boxSizing: 'border-box',
    width: 'min(400px, calc(100vw - 32px))',
    maxHeight: 'min(72dvh, 600px)',
    overflowY: 'auto',
    padding: cg.space[4],
    color: cg.text,
    backgroundColor: cg.surfaceRaised,
    border: `1px solid ${cg.glassBorder}`,
    borderRadius: cg.radius.lg,
    boxShadow: cg.shadowHigh,
  },
  title: {
    margin: `0 0 ${cg.space[3]}`,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
  },
  fields: { display: 'flex', flexDirection: 'column', gap: cg.space[4] },
});

export interface FilterPopoverProps {
  /** How many of the filters inside are set: shown on the button, so a closed popover still tells. */
  activeCount: number;
  /** The fields: `Field` with a `Select`, groups of checkboxes. */
  children: ReactNode;
  /** The button's text and the popover's name (default "Filters"). */
  title?: string;
}

/**
 * The filters that do not earn a place in the row: one button with the number that are on, and a popover (focus is kept
 * inside it, Escape closes it and returns to the button). The kit has no such control yet.
 */
export function FilterPopover({ activeCount, children, title = 'Filters' }: FilterPopoverProps) {
  const styles = useStyles();
  return (
    <Popover positioning="below-end" trapFocus>
      <PopoverTrigger disableButtonEnhancement>
        <Button
          variant="secondary"
          icon={<ListFilterIcon />}
          aria-label={activeCount > 0 ? `${title}, ${activeCount} on` : title}
        >
          {title}
          {activeCount > 0 ? (
            <Badge tone="brand" size="sm">
              {activeCount}
            </Badge>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverSurface className={styles.surface} aria-label={title}>
        <p className={styles.title}>{title}</p>
        <div className={styles.fields}>{children}</div>
      </PopoverSurface>
    </Popover>
  );
}
