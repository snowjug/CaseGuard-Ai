'use client';

import { cg } from '@caseguard/ui';
import { Button, makeStyles, tokens } from '@fluentui/react-components';
import { useId, useState } from 'react';
import { clipText } from '../../lib/text';

const useStyles = makeStyles({
  root: { display: 'inline', overflowWrap: 'anywhere' },
  toggle: {
    marginLeft: cg.space[1],
    minHeight: '24px',
    paddingInline: cg.space[1],
    fontSize: tokens.fontSizeBase200,
  },
});

/**
 * Cuts at the last word boundary before `limit` so a word is never split in the middle, and never between the two halves
 * of a surrogate pair (an emoji at the cut would otherwise end in a replacement character).
 */
export function truncateAtWord(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = clipText(text, limit);
  const space = cut.lastIndexOf(' ');
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export interface TruncatedTextProps {
  /** Case text. Always rendered as plain text, never as HTML. */
  text: string;
  /** Characters shown before the "Show more" control appears (default 220). */
  limit?: number;
  className?: string;
}

/**
 * Long case text, shortened with an accessible expand control: the hidden part is not in the DOM until the person asks
 * for it, and the button states what it will do and what it controls.
 */
export function TruncatedText({ text, limit = 220, className }: TruncatedTextProps) {
  const styles = useStyles();
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const long = text.length > limit;
  return (
    <span className={className ?? styles.root}>
      <span id={id}>{long && !expanded ? truncateAtWord(text, limit) : text}</span>
      {long ? (
        <Button
          appearance="transparent"
          size="small"
          className={styles.toggle}
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </Button>
      ) : null}
    </span>
  );
}
