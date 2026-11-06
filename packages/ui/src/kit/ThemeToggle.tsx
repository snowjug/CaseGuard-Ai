'use client';

import {
  Menu,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
  makeStyles,
} from '@fluentui/react-components';
import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import type { ReactElement } from 'react';
import { useThemeMode } from '../theme/ThemeProvider';
import { isThemeMode, type ThemeMode } from '../theme/theme-mode';
import { cg } from '../tokens/cg';
import { IconButton } from './Button';
import { SegmentedControl } from './SegmentedControl';

const OPTIONS: readonly { value: ThemeMode; label: string; icon: ReactElement }[] = [
  { value: 'light', label: 'Light', icon: <SunIcon /> },
  { value: 'dark', label: 'Dark', icon: <MoonIcon /> },
  { value: 'system', label: 'System', icon: <MonitorIcon /> },
];

const useStyles = makeStyles({
  popover: {
    padding: cg.space[1],
    borderRadius: cg.radius.md,
    backgroundColor: cg.surfaceRaised,
    border: `1px solid ${cg.glassBorder}`,
    boxShadow: cg.shadowHigh,
  },
});

export interface ThemeToggleProps {
  /** `segmented` shows Light, Dark and System side by side; `icon` is a compact button that opens the same three choices. */
  variant?: 'segmented' | 'icon';
}

/**
 * Light, dark or follow the system. The choice is saved in a cookie the server reads, so the next page already paints in
 * the right theme (no flash); until a choice is made the system setting decides.
 */
export function ThemeToggle({ variant = 'segmented' }: ThemeToggleProps) {
  const styles = useStyles();
  const { mode, resolved, setMode } = useThemeMode();
  if (variant === 'segmented') {
    return (
      <SegmentedControl
        aria-label="Theme"
        size="sm"
        value={mode}
        onValueChange={setMode}
        options={OPTIONS}
      />
    );
  }
  return (
    <Menu
      checkedValues={{ theme: [mode] }}
      onCheckedValueChange={(_event, data) => {
        const next = data.checkedItems[0];
        if (data.name === 'theme' && isThemeMode(next)) setMode(next);
      }}
    >
      <MenuTrigger disableButtonEnhancement>
        <IconButton
          icon={resolved === 'dark' ? <MoonIcon /> : <SunIcon />}
          label={`Theme: ${OPTIONS.find((option) => option.value === mode)?.label ?? 'System'}`}
          tooltip={false}
        />
      </MenuTrigger>
      <MenuPopover className={styles.popover}>
        <MenuList>
          {OPTIONS.map((option) => (
            <MenuItemRadio key={option.value} name="theme" value={option.value} icon={option.icon}>
              {option.label}
            </MenuItemRadio>
          ))}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}
