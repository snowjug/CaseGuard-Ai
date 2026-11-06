'use client';

import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import type { ComponentPropsWithoutRef } from 'react';
import { cg } from '../tokens/cg';

const useStyles = makeStyles({
  kbd: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '20px',
    minHeight: '20px',
    paddingInline: cg.space[2],
    borderRadius: cg.radius.sm,
    border: `1px solid ${cg.glassBorder}`,
    backgroundColor: cg.surfaceSunken,
    color: cg.textSecondary,
    fontFamily: cg.font.mono,
    fontSize: tokens.fontSizeBase100,
    lineHeight: tokens.lineHeightBase100,
    whiteSpace: 'nowrap',
  },
});

/** A keyboard key cap, for shortcut hints (`Ctrl K`, `Esc`). Decorative hints should pass `aria-hidden`. */
export function Kbd({ className, ...rest }: ComponentPropsWithoutRef<'kbd'>) {
  const styles = useStyles();
  return <kbd {...rest} className={mergeClasses(styles.kbd, className)} />;
}
