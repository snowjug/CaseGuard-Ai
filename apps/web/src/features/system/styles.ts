'use client';

import { cg } from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';

/** Shared small styles for the System Health panels. */
export const useSystemStyles = makeStyles({
  page: { display: 'flex', flexDirection: 'column', gap: cg.space[6], minWidth: 0 },
  busy: { opacity: 0.72 },
  actions: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: cg.space[3] },
  updated: { fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  band: {
    display: 'grid',
    gap: cg.space[4],
    gridTemplateColumns: 'minmax(0, 1fr)',
    alignItems: 'start',
    '@media (min-width: 1100px)': { gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' },
  },
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  headRow: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: cg.space[2] },
  meta: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  text: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
    overflowWrap: 'anywhere',
  },
  bullets: {
    margin: 0,
    paddingLeft: cg.space[4],
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.text,
  },
  stats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
    gap: cg.space[3],
    margin: 0,
  },
  stat: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
    padding: cg.space[3],
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surfaceSunken,
  },
  statLabel: {
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    color: cg.textMuted,
    fontWeight: tokens.fontWeightSemibold,
  },
  statValue: {
    margin: 0,
    fontSize: tokens.fontSizeBase500,
    lineHeight: tokens.lineHeightBase500,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: 'tabular-nums',
    color: cg.text,
  },
  statHint: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  mono: { fontFamily: cg.font.mono, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere' },
  cellStack: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  cellMuted: { fontSize: tokens.fontSizeBase200, color: cg.textMuted },
});

/** `model_provider` becomes `Model provider`. */
export function humanize(name: string): string {
  const spaced = name.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
