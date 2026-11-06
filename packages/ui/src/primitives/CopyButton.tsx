'use client';

import { makeStyles } from '@fluentui/react-components';
import { CheckIcon, CircleAlertIcon, CopyIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { VisuallyHidden } from '../a11y/VisuallyHidden';
import { Button, IconButton } from '../kit/Button';

type CopyState = 'idle' | 'copied' | 'failed';

const useStyles = makeStyles({ root: { display: 'inline-flex', alignItems: 'center' } });

/** Writes text to the clipboard; falls back to `execCommand` for non-secure contexts. Returns success. */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      console.warn('Clipboard API rejected the copy; trying the legacy path', error);
    }
  }
  if (typeof document === 'undefined') return false;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand('copy');
  } finally {
    document.body.removeChild(area);
  }
}

export interface CopyButtonProps {
  /** The text placed on the clipboard. */
  value: string;
  /** Accessible name before copying, for example "Copy reference". */
  label?: string;
  /** Visible text. Omit for an icon-only button (the label stays as the accessible name). */
  text?: string;
  size?: 'small' | 'medium';
  /** `subtle` and `transparent` are quiet (ghost) buttons; `outline` and `secondary` have an outline. */
  appearance?: 'subtle' | 'outline' | 'secondary' | 'transparent';
  /** Called after a successful copy (for example to show a toast). */
  onCopied?: () => void;
}

/** Copies `value`; announces "Copied" (or the failure) to assistive technology through a polite live region. */
export function CopyButton({
  value,
  label = 'Copy',
  text,
  size = 'small',
  appearance = 'subtle',
  onCopied,
}: CopyButtonProps) {
  const styles = useStyles();
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const onClick = useCallback(async () => {
    const ok = await copyText(value);
    setState(ok ? 'copied' : 'failed');
    if (ok) onCopied?.();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2000);
  }, [value, onCopied]);

  const icon =
    state === 'copied' ? <CheckIcon /> : state === 'failed' ? <CircleAlertIcon /> : <CopyIcon />;
  const visible =
    state === 'copied' ? (text ? 'Copied' : undefined) : state === 'failed' ? 'Copy failed' : text;
  const variant = appearance === 'subtle' || appearance === 'transparent' ? 'ghost' : 'secondary';
  const sizeName = size === 'small' ? 'sm' : 'md';
  return (
    <span className={styles.root}>
      {visible ? (
        <Button
          variant={variant}
          size={sizeName}
          icon={icon}
          onClick={() => void onClick()}
          title={label}
        >
          {visible}
        </Button>
      ) : (
        <IconButton
          variant={variant}
          size={sizeName}
          icon={icon}
          label={label}
          onClick={() => void onClick()}
        />
      )}
      <VisuallyHidden role="status" aria-live="polite">
        {state === 'copied' ? 'Copied to clipboard' : state === 'failed' ? 'Copy failed' : ''}
      </VisuallyHidden>
    </span>
  );
}
