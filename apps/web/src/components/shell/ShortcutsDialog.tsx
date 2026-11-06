'use client';

import { Dialog, Kbd, ScrollRegion, cg } from '@caseguard/ui';
import { Switch, makeStyles, tokens } from '@fluentui/react-components';
import { useId, useMemo } from 'react';
import {
  formatKeys,
  isSingleKeyShortcut,
  useShortcutList,
  type ShortcutDef,
} from '../../lib/shortcuts';
import { useSingleKeyToggle } from '../../lib/shortcuts/use-single-key-toggle';
import { useShellUi } from '../../lib/shell-ui';
import { useIsMac } from '../../lib/use-is-mac';

const useStyles = makeStyles({
  setting: { display: 'flex', flexDirection: 'column', gap: cg.space[1] },
  settingText: {
    margin: 0,
    paddingLeft: `calc(${cg.space[10]} + ${cg.space[1]})`,
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
  row: { display: 'contents' },
  term: { margin: 0, color: cg.text, fontSize: tokens.fontSizeBase300 },
  keys: { margin: 0, display: 'flex', gap: cg.space[1], alignItems: 'center' },
  note: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
});

/** Lists the registered shortcuts, grouped, and holds the setting that turns the single-key ones off. Opened with `?`. */
export function ShortcutsDialog() {
  const styles = useStyles();
  const { shortcutsOpen, setShortcutsOpen } = useShellUi();
  const list = useShortcutList();
  const singleKey = useSingleKeyToggle();
  const textId = useId();
  const mac = useIsMac();
  const mod = mac ? '⌘' : 'Ctrl';
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
    <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} title="Keyboard shortcuts">
      <div className={styles.setting}>
        <Switch
          label="Single-key shortcuts"
          checked={singleKey.enabled}
          aria-describedby={textId}
          onChange={(_event, data) => singleKey.set(data.checked)}
        />
        <p id={textId} className={styles.settingText}>
          Shortcuts made of one key, such as / or G then C. Turn them off if they get in the way of
          speech input or of keys you press by accident; shortcuts that use {mod}, such as{' '}
          {formatKeys('mod+k', mac)}, keep working.
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
                <div key={shortcut.id} className={styles.row}>
                  <dt className={styles.term}>{shortcut.description}</dt>
                  <dd className={styles.keys}>
                    <Kbd>{formatKeys(shortcut.keys, mac)}</Kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        <p className={styles.note}>
          Shortcuts do not fire while you are typing in a field or while a dialog is open.
          {singleKey.enabled
            ? ' Each page adds its own while you are on it, such as N for the next step on the guided demo.'
            : ''}
        </p>
        <p className={styles.note}>
          {singleKey.enabled
            ? 'Presenting? Open the guided demo (G then P) and choose Start presentation mode, or add ?present=1 to any address.'
            : 'Presenting? Open the guided demo from Advanced and choose Start presentation mode, or add ?present=1 to any address.'}
        </p>
      </ScrollRegion>
    </Dialog>
  );
}
