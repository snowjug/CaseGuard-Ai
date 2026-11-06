'use client';

import {
  MODEL_ESTIMATE_NOTICE,
  RESPONSIBLE_USE_NOTICE,
  SYNTHETIC_DATA_NOTICE,
} from '@caseguard/schemas';
import { Button, ProvenanceBadge, cg } from '@caseguard/ui';
import {
  Popover,
  PopoverSurface,
  PopoverTrigger,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { KeyboardIcon } from 'lucide-react';
import { publicEnv } from '../../lib/env';
import { useShellUi } from '../../lib/shell-ui';

const useStyles = makeStyles({
  pill: {
    display: 'inline-flex',
    minHeight: '32px',
    alignItems: 'center',
    padding: 0,
    border: 0,
    borderRadius: cg.radius.pill,
    backgroundColor: 'transparent',
    cursor: 'pointer',
    '@media (pointer: coarse)': {
      minHeight: '44px',
      minWidth: '44px',
      justifyContent: 'center',
    },
    ':focus-visible': { outline: `2px solid ${cg.focus}`, outlineOffset: '2px' },
  },
  surface: {
    maxWidth: '320px',
    padding: cg.space[4],
    color: cg.text,
    backgroundColor: cg.surfaceRaised,
    border: `1px solid ${cg.glassBorder}`,
    borderRadius: cg.radius.md,
    boxShadow: cg.shadowHigh,
    fontSize: tokens.fontSizeBase300,
  },
  popTitle: { margin: `0 0 ${cg.space[1]}`, fontWeight: tokens.fontWeightSemibold },
  popBody: { margin: 0, color: cg.textSecondary },
  footer: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: `${cg.space[2]} ${cg.space[6]}`,
    marginTop: cg.space[10],
    paddingTop: cg.space[4],
    borderTop: `1px solid ${cg.borderSubtle}`,
    color: cg.textMuted,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
  },
  notices: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    maxWidth: '78ch',
    margin: 0,
  },
});

/**
 * The one honesty marker of the shell: a small "Demo data" pill that opens the full sentence. It replaces the banner
 * that used to sit above the header.
 */
export function DemoDataPill() {
  const styles = useStyles();
  const sentence = `${SYNTHETIC_DATA_NOTICE}${publicEnv.appEnv === 'production' ? '' : ` Environment: ${publicEnv.appEnv}.`}`;
  return (
    <Popover positioning="below-end" withArrow>
      <PopoverTrigger disableButtonEnhancement>
        <button type="button" className={styles.pill} aria-label="Demo data: what this means">
          <ProvenanceBadge kind="synthetic" />
        </button>
      </PopoverTrigger>
      <PopoverSurface className={styles.surface} aria-label="About demo data">
        <p className={styles.popTitle}>Demo data</p>
        <p className={styles.popBody}>{sentence}</p>
      </PopoverSurface>
    </Popover>
  );
}

/** The responsible-use and estimate sentences, quiet, at the end of every page, with the keyboard shortcuts button. */
export function Footer() {
  const styles = useStyles();
  const { setShortcutsOpen } = useShellUi();
  return (
    <footer className={styles.footer}>
      <p className={styles.notices}>
        <span>{RESPONSIBLE_USE_NOTICE}</span>
        <span>{MODEL_ESTIMATE_NOTICE}</span>
      </p>
      <Button
        variant="ghost"
        size="sm"
        icon={<KeyboardIcon />}
        onClick={() => setShortcutsOpen(true)}
      >
        Keyboard shortcuts
      </Button>
    </footer>
  );
}
