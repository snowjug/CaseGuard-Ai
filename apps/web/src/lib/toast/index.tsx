'use client';

import { cg, layout, useMediaQuery } from '@caseguard/ui';
import {
  Link,
  Toast,
  ToastBody,
  ToastTitle,
  ToastTrigger,
  Toaster,
  makeStyles,
  tokens,
  useId,
  useToastController,
  type ToastIntent,
} from '@fluentui/react-components';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { usePresentation } from '../presentation';
import { usePresenterHeight } from '../presentation/presenter-height';

const useStyles = makeStyles({
  toast: {
    border: `1px solid ${cg.glassBorder}`,
    borderRadius: cg.radius.md,
    backgroundColor: cg.surfaceRaised,
    color: cg.text,
    boxShadow: `inset 0 1px 0 ${cg.highlight}, ${cg.shadowHigh}`,
    fontSize: tokens.fontSizeBase300,
  },
});

export interface ToastOptions {
  /** Secondary line under the title. */
  body?: ReactNode;
  /** Milliseconds before it disappears (default 5000; 0 keeps it until dismissed). */
  timeoutMs?: number;
}

export interface UndoToastOptions extends ToastOptions {
  /** Called when the person clicks Undo within the window. */
  onUndo: () => void;
  /** Label of the undo link (default "Undo"). */
  undoLabel?: string;
}

export interface ToastApi {
  success: (title: string, options?: ToastOptions) => void;
  info: (title: string, options?: ToastOptions) => void;
  warning: (title: string, options?: ToastOptions) => void;
  error: (title: string, options?: ToastOptions) => void;
  /** A reversible action (for example dismissing a warning): shows an Undo link for a short window (8 s by default). */
  undoable: (title: string, options: UndoToastOptions) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * Toasts for the result of actions. Fluent announces them in its own polite (assertive for errors) live regions, and
 * the visible toasts are mounted inside a named "Notifications" landmark: left in the default portal they would sit
 * outside every landmark, which axe reports (`region`) while one is on screen.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const styles = useStyles();
  const toasterId = useId('toaster');
  const { dispatchToast } = useToastController(toasterId);
  const { enabled: presenting } = usePresentation();
  const presenterHeight = usePresenterHeight(presenting);
  const phone = useMediaQuery(`(max-width: ${layout.drawerBreakpoint - 1}px)`);
  const [host, setHost] = useState<HTMLElement | null>(null);

  const show = useCallback(
    (intent: ToastIntent, title: string, options: ToastOptions = {}, action?: ReactElement) => {
      dispatchToast(
        <Toast className={styles.toast}>
          <ToastTitle action={action}>{title}</ToastTitle>
          {options.body ? <ToastBody>{options.body}</ToastBody> : null}
        </Toast>,
        {
          intent,
          timeout: options.timeoutMs ?? 5000,
          politeness: intent === 'error' ? 'assertive' : 'polite',
        },
      );
    },
    [dispatchToast, styles.toast],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (title, options) => show('success', title, options),
      info: (title, options) => show('info', title, options),
      warning: (title, options) => show('warning', title, options),
      error: (title, options) => show('error', title, options),
      undoable: (title, options) =>
        show(
          'info',
          title,
          { ...options, timeoutMs: options.timeoutMs ?? 8000 },
          <ToastTrigger>
            <Link onClick={options.onUndo}>{options.undoLabel ?? 'Undo'}</Link>
          </ToastTrigger>,
        ),
    }),
    [show],
  );

  // Toasts sit above the presenter strip while presenting, and above the bottom bar on a phone.
  const vertical = (presenting ? presenterHeight + 12 : 16) + (phone ? layout.bottomBarHeight : 0);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div ref={setHost} role="region" aria-label="Notifications" />
      <Toaster
        toasterId={toasterId}
        mountNode={host}
        position="bottom-end"
        limit={4}
        offset={{ vertical }}
      />
    </ToastContext.Provider>
  );
}

/** Show results of actions: `const toast = useToast(); toast.success('Saved')`. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside <ToastProvider>');
  return api;
}
