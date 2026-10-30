'use client';

import { cg } from '@caseguard/ui';
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { DismissRegular } from '@fluentui/react-icons';
import { useMemo } from 'react';
import { formatKeys, useShortcutList, type ShortcutDef } from '../../lib/shortcuts';
import { useShellUi } from '../../lib/shell-ui';

const useStyles = makeStyles({
  content: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[4],
    maxHeight: '60vh',
    overflowY: 'auto',
  },
  group: { display: 'flex', flexDirection: 'column', gap: cg.space[1] },
  heading: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.textSecondary,
  },
  list: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: `${cg.space[2]} ${cg.space[4]}`,
    margin: 0,
  },
  term: { margin: 0, color: cg.text, fontSize: tokens.fontSizeBase300 },
  keys: { margin: 0, display: 'flex', gap: cg.space[1], alignItems: 'center' },
  kbd: {
    padding: '2px 8px',
    borderRadius: cg.radius.sm,
    border: `1px solid ${cg.borderControl}`,
    backgroundColor: cg.surfaceSunken,
    fontFamily: cg.font.mono,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: 'nowrap',
  },
  note: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
});

const isMac = (): boolean =>
  typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform);

/** Lists the registered shortcuts, grouped. Opened with `?`. */
export function ShortcutsDialog() {
  const styles = useStyles();
  const { shortcutsOpen, setShortcutsOpen } = useShellUi();
  const list = useShortcutList();
  // Read the registry when the dialog opens so it reflects the shortcuts of the current page.
  const groups = useMemo(() => {
    if (!shortcutsOpen) return [] as [string, ShortcutDef[]][];
    const byGroup = new Map<string, ShortcutDef[]>();
    for (const shortcut of list())
      byGroup.set(shortcut.group, [...(byGroup.get(shortcut.group) ?? []), shortcut]);
    return [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [shortcutsOpen, list]);

  return (
    <Dialog open={shortcutsOpen} onOpenChange={(_event, data) => setShortcutsOpen(data.open)}>
      <DialogSurface aria-describedby={undefined}>
        <DialogBody>
          <DialogTitle
            action={
              <Button
                appearance="subtle"
                aria-label="Close"
                icon={<DismissRegular />}
                onClick={() => setShortcutsOpen(false)}
              />
            }
          >
            Keyboard shortcuts
          </DialogTitle>
          <DialogContent
            className={styles.content}
            // The list can outgrow the dialog, so it is a focusable scroll region: keyboard users can scroll it.
            tabIndex={0}
            role="region"
            aria-label="Keyboard shortcut list"
          >
            {groups.map(([group, shortcuts]) => (
              <section key={group} className={styles.group} aria-label={group}>
                <h3 className={styles.heading}>{group}</h3>
                <dl className={styles.list}>
                  {shortcuts.map((shortcut) => (
                    <div key={shortcut.id} style={{ display: 'contents' }}>
                      <dt className={styles.term}>{shortcut.description}</dt>
                      <dd className={styles.keys}>
                        <kbd className={styles.kbd}>{formatKeys(shortcut.keys, isMac())}</kbd>
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
            <p className={styles.note}>
              Shortcuts do not fire while you are typing in a field or while a dialog is open.
            </p>
          </DialogContent>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
