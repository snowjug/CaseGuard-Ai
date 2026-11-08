'use client';

import { Button, cg } from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { useId, useState } from 'react';
import { clipText } from '../../lib/text';

const useStyles = makeStyles({
  text: {
    margin: 0,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.text,
  },
  mono: {
    fontFamily: cg.font.mono,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
  },
});

/**
 * Long text rendered strictly as text (never as markup), cut to `limit` characters (never inside an emoji or another
 * surrogate pair) with an accessible control that shows all of it. Short text is shown as is, without a control.
 */
export function ExpandableText({
  text,
  limit = 240,
  mono = false,
}: {
  text: string;
  limit?: number;
  mono?: boolean;
}) {
  const styles = useStyles();
  const id = useId();
  const [open, setOpen] = useState(false);
  const long = text.length > limit;
  const shown = open || !long ? text : `${clipText(text, limit).trimEnd()}…`;
  return (
    <div>
      <p id={id} className={mergeClasses(styles.text, mono && styles.mono)}>
        {shown}
      </p>
      {long ? (
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? 'Show less' : `Show all ${text.length.toLocaleString('en-US')} characters`}
        </Button>
      ) : null}
    </div>
  );
}
