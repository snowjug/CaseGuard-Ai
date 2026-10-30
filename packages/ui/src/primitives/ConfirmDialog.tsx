'use client';

import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Field,
  Spinner,
  Textarea,
  makeStyles,
  tokens,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { useState, type ReactElement, type ReactNode } from 'react';
import { cg } from '../tokens/cg';

const useStyles = makeStyles({
  content: { display: 'flex', flexDirection: 'column', gap: cg.space[3], color: cg.textSecondary },
  error: { margin: 0, color: cg.tone.unsupported.fg, fontSize: tokens.fontSizeBase300 },
  danger: {
    backgroundColor: cg.tone.unsupported.solid,
    color: cg.tone.unsupported.onSolid,
    ':hover': { backgroundColor: cg.tone.unsupported.fg, color: cg.tone.unsupported.tint },
  },
});

export interface ConfirmReasonOptions {
  /** Label of the reason field, for example "Reason for rejecting this path". */
  label: string;
  /** Minimum length that the API also enforces (default 5). */
  minLength?: number;
  maxLength?: number;
  placeholder?: string;
}

export interface ConfirmDialogProps {
  /** Controlled open state. Omit when you pass `trigger`. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Element that opens the dialog (usually a `Button`). When given, Fluent restores focus to it on close.
   * With controlled `open`, spread `useRestoreFocusTarget()` onto your opener instead.
   */
  trigger?: ReactElement;
  title: string;
  /** What will happen and what it affects. Say it in plain words. */
  children: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` styles the confirm button as destructive (delete, reset, reject). */
  tone?: 'default' | 'danger';
  /** Collects a mandatory reason (reviews and dismissals are audited). */
  reason?: ConfirmReasonOptions;
  /**
   * Performs the action. The dialog stays open with a spinner until it settles; a rejected promise keeps it open and
   * shows the error message so nothing is lost silently.
   */
  onConfirm: (reason: string) => void | Promise<void>;
}

/**
 * Confirmation for consequential actions (approve or publish a skill, reject a counterfactual, reset the demo,
 * delete a case). It is an `alertdialog`: focus is trapped, Esc cancels, and focus returns to the opener.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  trigger,
  title,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  reason,
  onConfirm,
}: ConfirmDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open ?? internalOpen;
  const setOpen = (next: boolean): void => {
    if (open === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };
  const surface = (
    <DialogSurface>
      <ConfirmBody
        title={title}
        confirmLabel={confirmLabel}
        cancelLabel={cancelLabel}
        tone={tone}
        reason={reason}
        onConfirm={onConfirm}
        onClose={() => setOpen(false)}
      >
        {children}
      </ConfirmBody>
    </DialogSurface>
  );
  const handleOpenChange = (_event: unknown, data: { open: boolean }): void => setOpen(data.open);
  if (trigger) {
    return (
      <Dialog modalType="alert" open={isOpen} onOpenChange={handleOpenChange}>
        <DialogTrigger disableButtonEnhancement>{trigger}</DialogTrigger>
        {surface}
      </Dialog>
    );
  }
  return (
    <Dialog modalType="alert" open={isOpen} onOpenChange={handleOpenChange}>
      {surface}
    </Dialog>
  );
}

interface ConfirmBodyProps {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  tone: 'default' | 'danger';
  reason: ConfirmReasonOptions | undefined;
  onConfirm: (reason: string) => void | Promise<void>;
  onClose: () => void;
}

// Mounted only while the dialog is open, so its state resets every time the dialog opens.
function ConfirmBody({
  title,
  children,
  confirmLabel,
  cancelLabel,
  tone,
  reason,
  onConfirm,
  onClose,
}: ConfirmBodyProps) {
  const styles = useStyles();
  const [text, setText] = useState('');
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const minLength = reason?.minLength ?? 5;
  const reasonInvalid = reason !== undefined && text.trim().length < minLength;

  const confirm = async (): Promise<void> => {
    setTouched(true);
    if (reasonInvalid) return;
    setPending(true);
    setFailure(null);
    try {
      await onConfirm(text.trim());
      onClose();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'The action could not be completed.');
    } finally {
      setPending(false);
    }
  };

  return (
    <DialogBody>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent className={styles.content}>
        <div>{children}</div>
        {reason ? (
          <Field
            label={reason.label}
            required
            validationState={touched && reasonInvalid ? 'error' : 'none'}
            validationMessage={
              touched && reasonInvalid ? `Enter at least ${minLength} characters.` : undefined
            }
          >
            <Textarea
              value={text}
              onChange={(_e, data) => setText(data.value)}
              maxLength={reason.maxLength ?? 500}
              placeholder={reason.placeholder}
              rows={3}
              disabled={pending}
            />
          </Field>
        ) : null}
        {failure ? (
          <p role="alert" className={styles.error}>
            {failure}
          </p>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button appearance="secondary" onClick={onClose} disabled={pending}>
          {cancelLabel}
        </Button>
        <Button
          appearance="primary"
          className={tone === 'danger' ? styles.danger : undefined}
          onClick={() => void confirm()}
          disabled={pending}
          icon={pending ? <Spinner size="tiny" /> : undefined}
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </DialogBody>
  );
}

export { useRestoreFocusTarget };
