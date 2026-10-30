'use client';

import { cg } from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { formatInstant } from './format';

const useStyles = makeStyles({
  root: { margin: 0, fontSize: tokens.fontSizeBase300, color: cg.textSecondary },
});

/**
 * What a page says while an earlier moment loads: which moment it is looking up. Nothing of another moment is on screen
 * meanwhile (a read never serves the answer of a different boundary), so this and the page's skeleton are all there is.
 */
export function LookingUp({ asOf }: { asOf: string }) {
  const styles = useStyles();
  return (
    <p className={styles.root} role="status">
      Looking up what was known at {formatInstant(asOf)}…
    </p>
  );
}
