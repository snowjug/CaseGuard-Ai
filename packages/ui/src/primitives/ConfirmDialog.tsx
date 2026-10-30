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
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
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
   * Performs the action. The dialog stays open with a spinner until it settles and ignores every request to close it
   * meanwhile (Escape included), so the outcome is always seen; a rejected promise keeps it open and shows the error
   * message so nothing is lost silently.
   */
  onConfirm: (reason: string) => void | Promise<void>;
}

/**
 * Confirmation for consequential actions (approve or publish a skill, reject a counterfactual, reset the demo,
 * delete a case). It is an `alertdialog`: focus is trapped, Esc cancels (not while the action runs), and focus
 * returns to the opener.
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

  // The state of the action lives here, not in the body: the body unmounts when the dialog closes, and the outcome of
  // an action that was started must still be handled (and shown) by something that is there.
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Every opening starts without the message of an earlier failure.
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (wasOpen !== isOpen) {
    setWasOpen(isOpen);
    setFailure(null);
  }

  const requestClose = (): void => {
    if (!running.current) setOpen(false);
  };
  const run = async (text: string): Promise<void> => {
    if (running.current) return;
    running.current = true;
    setPending(true);
    setFailure(null);
    let message: string | null = null;
    try {
      await onConfirm(text);
    } catch (error) {
      message = error instanceof Error ? error.message : 'The action could not be completed.';
    }
    running.current = false;
    // The dialog itself may be gone by now (its owner was removed): there is nothing left to update or to tell.
    if (!mounted.current) return;
    setPending(false);
    if (message === null) setOpen(false);
    else setFailure(message);
  };

  const surface = (
    <DialogSurface>
      <ConfirmBody
        title={title}
        confirmLabel={confirmLabel}
        cancelLabel={cancelLabel}
        tone={tone}
        reason={reason}
        pending={pending}
        failure={failure}
        onConfirm={run}
        onCancel={requestClose}
      >
        {children}
      </ConfirmBody>
    </DialogSurface>
  );
  const handleOpenChange = (_event: unknown, data: { open: boolean }): void => {
    if (data.open) setOpen(true);
    else requestClose();
  };
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
  pending: boolean;
  failure: string | null;
  onConfirm: (reason: string) => Promise<void>;
  onCancel: () => void;
}

// Mounted only while the dialog is open, so the reason text resets every time the dialog opens.
function ConfirmBody({
  title,
  children,
  confirmLabel,
  cancelLabel,
  tone,
  reason,
  pending,
  failure,
  onConfirm,
  onCancel,
}: ConfirmBodyProps) {
  const styles = useStyles();
  const [text, setText] = useState('');
  const [touched, setTouched] = useState(false);
  const confirmButton = useRef<HTMLButtonElement>(null);

  // A browser takes the focus away from a button that becomes disabled, and a dialog whose focus is outside it no
  // longer hears Escape: when a failure leaves the dialog open, hand the focus back to the action that can be retried.
  useEffect(() => {
    if (failure !== null) confirmButton.current?.focus();
  }, [failure]);

  const minLength = reason?.minLength ?? 5;
  const reasonInvalid = reason !== undefined && text.trim().length < minLength;

  const confirm = (): void => {
    setTouched(true);
    if (!reasonInvalid) void onConfirm(text.trim());
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
        <Button appearance="secondary" onClick={onCancel} disabled={pending}>
          {cancelLabel}
        </Button>
        <Button
          ref={confirmButton}
          appearance="primary"
          className={tone === 'danger' ? styles.danger : undefined}
          onClick={confirm}
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
