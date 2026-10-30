'use client';

import { cg } from '@caseguard/ui';
import { Button, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { useId, useState } from 'react';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: cg.space[1], minWidth: 0 },
  text: {
    margin: 0,
    color: cg.text,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    overflowWrap: 'anywhere',
    whiteSpace: 'pre-wrap',
  },
  clamped: { display: '-webkit-box', WebkitBoxOrient: 'vertical', overflow: 'hidden' },
  toggle: { alignSelf: 'flex-start', minHeight: '24px', paddingInline: cg.space[1] },
});

export interface ExpandableTextProps {
  /** Case text. Always rendered as plain text, never as markup. */
  text: string;
  /** Lines shown while collapsed (default 3). */
  lines?: number;
  className?: string;
  /** Noun for the toggle's accessible name, for example "event text". */
  label?: string;
}

/** Characters per line below which a text certainly fits; longer text gets the expand control. */
const CHARS_PER_LINE = 70;

/**
 * Long case text, clamped to a few lines with an accessible "Show more" control (`aria-expanded`). The text itself is
 * always in the DOM, so screen readers and find-in-page see all of it; only the visual height is limited.
 */
export function ExpandableText({
  text,
  lines = 3,
  className,
  label = 'text',
}: ExpandableTextProps) {
  const styles = useStyles();
  const id = useId();
  const [open, setOpen] = useState(false);
  const long = text.length > lines * CHARS_PER_LINE || text.split('\n').length > lines;
  return (
    <div className={styles.root}>
      <p
        id={id}
        className={mergeClasses(styles.text, long && !open && styles.clamped, className)}
        style={long && !open ? { WebkitLineClamp: lines } : undefined}
      >
        {text}
      </p>
      {long ? (
        <Button
          appearance="transparent"
          size="small"
          className={styles.toggle}
          aria-expanded={open}
          aria-controls={id}
          aria-label={open ? `Show less ${label}` : `Show more ${label}`}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? 'Show less' : 'Show more'}
        </Button>
      ) : null}
    </div>
  );
}
