'use client';

import { ScrollRegion, cg } from '@caseguard/ui';
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Switch,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { DismissRegular } from '@fluentui/react-icons';
import { useId, useMemo } from 'react';
import {
  formatKeys,
  isSingleKeyShortcut,
  useShortcutList,
  type ShortcutDef,
} from '../../lib/shortcuts';
import { useSingleKeyToggle } from '../../lib/shortcuts/use-single-key-toggle';
import { useShellUi } from '../../lib/shell-ui';

const useStyles = makeStyles({
  frame: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  setting: { display: 'flex', flexDirection: 'column', gap: cg.space[1] },
  settingText: {
    margin: 0,
    paddingLeft: '44px',
    fontSize: tokens.fontSizeBase200,
    color: cg.textSecondary,
  },
  content: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[4],
    maxHeight: '50vh',
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

/** Lists the registered shortcuts, grouped, and holds the setting that turns the single-key ones off. Opened with `?`. */
export function ShortcutsDialog() {
  const styles = useStyles();
  const { shortcutsOpen, setShortcutsOpen } = useShellUi();
  const list = useShortcutList();
  const singleKey = useSingleKeyToggle();
  const textId = useId();
  const mod = isMac() ? '⌘' : 'Ctrl';
  // Read the registry when the dialog opens so it reflects the shortcuts of the current page. With the single-key
  // shortcuts off, only what still works is listed.
  const groups = useMemo(() => {
    if (!shortcutsOpen) return [] as [string, ShortcutDef[]][];
    const byGroup = new Map<string, ShortcutDef[]>();
    for (const shortcut of list()) {
      if (!singleKey.enabled && isSingleKeyShortcut(shortcut.keys)) continue;
      byGroup.set(shortcut.group, [...(byGroup.get(shortcut.group) ?? []), shortcut]);
    }
    return [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [shortcutsOpen, list, singleKey.enabled]);

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
          <DialogContent className={styles.frame}>
            <div className={styles.setting}>
              <Switch
                label="Single-key shortcuts"
                checked={singleKey.enabled}
                aria-describedby={textId}
                onChange={(_event, data) => singleKey.set(data.checked)}
              />
              <p id={textId} className={styles.settingText}>
                Shortcuts made of one key, such as / or G then C. Turn them off if they get in the
                way of speech input or of keys you press by accident; shortcuts that use {mod}, such
                as {formatKeys('mod+k', isMac())}, keep working.
                {singleKey.enabled
                  ? ''
                  : ` Single-key shortcuts are off now, so only shortcuts that use ${mod} work and only those are listed.`}
              </p>
            </div>
            {/* The list can outgrow the dialog, so it is a focusable scroll region: keyboard users can scroll it. */}
            <ScrollRegion label="Keyboard shortcut list" className={styles.content}>
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
                {singleKey.enabled
                  ? ' Each page adds its own while you are on it, such as N for the next step on the Demo Guide.'
                  : ''}
              </p>
              <p className={styles.note}>
                {singleKey.enabled
                  ? 'Presenting? Open the Demo Guide (G then P) and choose Start presentation mode, or add ?present=1 to any address.'
                  : 'Presenting? Open the Demo Guide from the navigation and choose Start presentation mode, or add ?present=1 to any address.'}
              </p>
            </ScrollRegion>
          </DialogContent>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
