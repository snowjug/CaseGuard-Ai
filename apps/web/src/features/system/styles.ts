'use client';

import { cg } from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';

/** Shared small styles for the System status sections. */
export const useSystemStyles = makeStyles({
  page: { display: 'flex', flexDirection: 'column', gap: cg.space[6], minWidth: 0 },
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  columns: {
    display: 'grid',
    gap: `${cg.space[4]} ${cg.space[8]}`,
    gridTemplateColumns: 'minmax(0, 1fr)',
    alignItems: 'start',
    '@media (min-width: 900px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
  },
  head: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: cg.space[2] },
  headSpacer: { marginInlineStart: 'auto' },
  subhead: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
  },
  text: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
    overflowWrap: 'anywhere',
  },
  meta: {
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    color: cg.textMuted,
  },
  noteLabel: { fontWeight: tokens.fontWeightSemibold, color: cg.text },
  bullets: {
    margin: 0,
    paddingLeft: cg.space[4],
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
  },
  bulletName: { color: cg.text, fontWeight: tokens.fontWeightSemibold },
  mono: { fontFamily: cg.font.mono, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere' },
  cellStack: { display: 'flex', flexDirection: 'column', gap: cg.space[1], minWidth: 0 },
  cellMuted: { fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  detail: {
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    color: cg.textSecondary,
    overflowWrap: 'anywhere',
  },
});

/** `model_provider` becomes `Model provider`. */
export function humanize(name: string): string {
  const spaced = name.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
