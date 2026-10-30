'use client';

import {
  MODEL_ESTIMATE_NOTICE,
  RESPONSIBLE_USE_NOTICE,
  SYNTHETIC_DATA_NOTICE,
} from '@caseguard/schemas';
import { ProvenanceBadge, cg } from '@caseguard/ui';
import { Button, makeStyles, tokens } from '@fluentui/react-components';
import { KeyboardRegular } from '@fluentui/react-icons';
import { publicEnv } from '../../lib/env';
import { useAuth } from '../../lib/auth/context';
import { DevIdentityBadge } from '../../lib/auth/dev-persona';
import { usePresentation } from '../../lib/presentation';
import { useShellUi } from '../../lib/shell-ui';

const useBar = makeStyles({
  bar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: `0 ${cg.space[3]}`,
    minHeight: '28px',
    padding: `2px ${cg.space[4]}`,
    backgroundColor: cg.tone.neutral.tint,
    borderBottom: `1px dashed ${cg.tone.neutral.border}`,
    color: cg.tone.neutral.fg,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    textAlign: 'center',
  },
  // On narrow screens the badge carries the message; the sentence stays available to assistive technology.
  sentence: {
    '@media (max-width: 719px)': {
      position: 'absolute',
      width: '1px',
      height: '1px',
      overflow: 'hidden',
      clipPath: 'inset(50%)',
      whiteSpace: 'nowrap',
    },
  },
});

/** Persistent, unobtrusive honesty notice above the header. */
export function HonestyBar() {
  const styles = useBar();
  const auth = useAuth();
  const presentation = usePresentation();
  return (
    <div className={styles.bar}>
      <ProvenanceBadge kind="synthetic" label="Synthetic demo data" />
      <span className={styles.sentence}>
        {SYNTHETIC_DATA_NOTICE}
        {publicEnv.appEnv === 'production' ? '' : ` Environment: ${publicEnv.appEnv}.`}
      </span>
      {auth.mode === 'dev' && !presentation.enabled ? <DevIdentityBadge /> : null}
    </div>
  );
}

const useFooter = makeStyles({
  footer: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: `${cg.space[2]} ${cg.space[6]}`,
    padding: `${cg.space[4]} ${cg.space[6]}`,
    borderTop: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surface,
    color: cg.textSecondary,
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

/** Footer with the synthetic-data and responsible-use notices. */
export function Footer() {
  const styles = useFooter();
  const { setShortcutsOpen } = useShellUi();
  return (
    <footer className={styles.footer}>
      <p className={styles.notices}>
        <span>{RESPONSIBLE_USE_NOTICE}</span>
        <span>{MODEL_ESTIMATE_NOTICE}</span>
      </p>
      <Button
        appearance="subtle"
        size="small"
        icon={<KeyboardRegular />}
        onClick={() => setShortcutsOpen(true)}
      >
        Keyboard shortcuts
      </Button>
    </footer>
  );
}
