'use client';

import {
  Link,
  Toast,
  ToastBody,
  ToastTitle,
  ToastTrigger,
  Toaster,
  useId,
  useToastController,
  type ToastIntent,
} from '@fluentui/react-components';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactElement,
  type ReactNode,
} from 'react';
import { usePresentation } from '../presentation';

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

/** Toasts for the result of actions. Fluent renders them in a polite live region. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const toasterId = useId('toaster');
  const { dispatchToast } = useToastController(toasterId);
  const { enabled: presenting } = usePresentation();

  const show = useCallback(
    (intent: ToastIntent, title: string, options: ToastOptions = {}, action?: ReactElement) => {
      dispatchToast(
        <Toast>
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
    [dispatchToast],
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

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* Toasts stay clear of the presenter strip, which is fixed to the bottom while presenting. */}
      <Toaster
        toasterId={toasterId}
        position="bottom-end"
        limit={4}
        offset={{ vertical: presenting ? 104 : 16 }}
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
