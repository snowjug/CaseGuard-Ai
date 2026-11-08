'use client';

import { cg } from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';

/** Text and layout pieces shared by the Score and Quality screens. */
export const useLook = makeStyles({
  page: { display: 'flex', flexDirection: 'column', gap: cg.space[6], minWidth: 0 },
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  tight: { display: 'flex', flexDirection: 'column', gap: cg.space[2], minWidth: 0 },
  row: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${cg.space[2]} ${cg.space[3]}`,
  },
  busy: { opacity: 0.72 },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
    overflowWrap: 'anywhere',
  },
  heading: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.01em',
    color: cg.text,
  },
  text: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
    overflowWrap: 'anywhere',
  },
  strong: { color: cg.text, fontWeight: tokens.fontWeightSemibold },
  meta: {
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    color: cg.textMuted,
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
    color: cg.textSecondary,
  },
  mono: { fontFamily: cg.font.mono, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere' },
  fill: { height: '100%', boxSizing: 'border-box' },
});
