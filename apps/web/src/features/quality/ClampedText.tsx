'use client';

import { Button, cg } from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { useId, useState } from 'react';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: cg.space[1], minWidth: 0 },
  text: {
    margin: 0,
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    overflowWrap: 'anywhere',
    whiteSpace: 'pre-wrap',
  },
  clamped: { display: '-webkit-box', WebkitBoxOrient: 'vertical', overflow: 'hidden' },
  toggle: { alignSelf: 'flex-start', marginInlineStart: `calc(${cg.space[3]} * -1)` },
});

/** Characters per line below which a text certainly fits; longer text gets the expand control. */
const CHARS_PER_LINE = 80;

export interface ClampedTextProps {
  /** Always rendered as plain text, never as markup. */
  text: string;
  /** Lines shown while collapsed (default 3). */
  lines?: number;
  /** Noun for the toggle's accessible name, for example "rationale". */
  label?: string;
  className?: string;
}

/**
 * Long text clamped to a few lines with an accessible "Show more" control (`aria-expanded`). The full text stays in the
 * DOM, so screen readers and find-in-page see all of it; only its visual height is limited.
 */
export function ClampedText({ text, lines = 3, label = 'text', className }: ClampedTextProps) {
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
          variant="ghost"
          size="sm"
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
