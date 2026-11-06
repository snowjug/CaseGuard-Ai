'use client';

import {
  Dialog as FluentDialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { XIcon } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { cg } from '../tokens/cg';
import { IconButton } from './Button';

const useStyles = makeStyles({
  surface: {
    padding: cg.space[6],
    borderRadius: cg.radius.xl,
    border: `1px solid ${cg.glassBorder}`,
    backgroundColor: cg.surfaceRaised,
    color: cg.text,
    boxShadow: cg.shadowHigh,
    width: `min(calc(100vw - ${cg.space[8]}), var(--cg-dialog-width, 560px))`,
    maxWidth: 'none',
  },
  sm: { '--cg-dialog-width': '420px' },
  md: { '--cg-dialog-width': '560px' },
  lg: { '--cg-dialog-width': '720px' },
  backdrop: { backdropFilter: 'blur(4px)' },
  body: { display: 'flex', flexDirection: 'column', gap: cg.space[4], overflow: 'visible' },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase500,
    lineHeight: tokens.lineHeightBase500,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.015em',
    color: cg.text,
  },
  content: { display: 'flex', flexDirection: 'column', gap: cg.space[3], color: cg.textSecondary },
  description: { margin: 0, fontSize: tokens.fontSizeBase300, color: cg.textSecondary },
  actions: { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: cg.space[2] },
});

/** The class names of the kit's dialog, for dialogs that need Fluent's own parts (a trigger, a custom body). */
export function useDialogClasses(size: 'sm' | 'md' | 'lg' = 'md') {
  const styles = useStyles();
  return {
    surface: mergeClasses(styles.surface, styles[size]),
    backdrop: styles.backdrop,
    body: styles.body,
    title: styles.title,
    content: styles.content,
    actions: styles.actions,
  };
}

/** Returns focus to the control that opened the dialog when it closes (Fluent only does that for its own triggers). */
function useReturnFocus(open: boolean): void {
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      opener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      return undefined;
    }
    const node = opener.current;
    opener.current = null;
    if (node?.isConnected) node.focus();
    return undefined;
  }, [open]);
}

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** One or two sentences: what will happen and what it affects. */
  description?: ReactNode;
  children?: ReactNode;
  /** The buttons: at most one primary, last. */
  actions?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** `alert` for a confirmation that must be answered: it is announced as an alert dialog, has no close button, and a click outside does not dismiss it (Escape still cancels). */
  modalType?: 'modal' | 'alert';
}

/**
 * A modal dialog on a raised surface over a softly blurred page: focus is trapped, Escape closes it (not an `alert`),
 * and focus returns to where it was. Never open one from inside another.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  actions,
  size = 'md',
  modalType = 'modal',
}: DialogProps) {
  const styles = useStyles();
  useReturnFocus(open);
  return (
    <FluentDialog
      open={open}
      modalType={modalType}
      onOpenChange={(_event, data) => onOpenChange(data.open)}
    >
      <DialogSurface
        className={mergeClasses(styles.surface, styles[size])}
        backdrop={{ className: styles.backdrop }}
      >
        <DialogBody className={styles.body}>
          <DialogTitle
            className={styles.title}
            action={
              modalType === 'modal' ? (
                <IconButton
                  icon={<XIcon />}
                  label="Close"
                  size="sm"
                  tooltip={false}
                  onClick={() => onOpenChange(false)}
                />
              ) : undefined
            }
          >
            {title}
          </DialogTitle>
          {description || children ? (
            <DialogContent className={styles.content}>
              {description ? <p className={styles.description}>{description}</p> : null}
              {children}
            </DialogContent>
          ) : null}
          {actions ? <DialogActions className={styles.actions}>{actions}</DialogActions> : null}
        </DialogBody>
      </DialogSurface>
    </FluentDialog>
  );
}
