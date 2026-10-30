'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

type Labels = Readonly<Record<string, string>>;

interface LabelStore {
  set: (key: string, label: string) => void;
  remove: (key: string) => void;
  get: () => Labels;
  subscribe: (listener: () => void) => () => void;
}

const empty: Labels = {};
const LabelContext = createContext<LabelStore | null>(null);

/** Lets pages replace a raw id in the breadcrumbs with a readable label ("CASE-0001" instead of "case_01H..."). */
export function BreadcrumbLabelsProvider({ children }: { children: ReactNode }) {
  const labels = useRef<Labels>(empty);
  const listeners = useRef(new Set<() => void>());
  const store = useMemo<LabelStore>(() => {
    const emit = (): void => {
      for (const listener of listeners.current) listener();
    };
    return {
      set: (key, label) => {
        if (labels.current[key] === label) return;
        labels.current = { ...labels.current, [key]: label };
        emit();
      },
      remove: (key) => {
        if (!(key in labels.current)) return;
        const { [key]: _removed, ...rest } = labels.current;
        labels.current = rest;
        emit();
      },
      get: () => labels.current,
      subscribe: (listener) => {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
    };
  }, []);
  return <LabelContext.Provider value={store}>{children}</LabelContext.Provider>;
}

/** Registers a breadcrumb label for a dynamic segment: key `case:<id>` or `skill:<id>`. Pass `undefined` until it is known. */
export function useBreadcrumbLabel(key: string, label: string | undefined): void {
  const store = useContext(LabelContext);
  useEffect(() => {
    if (!store || !label) return undefined;
    store.set(key, label);
    return () => store.remove(key);
  }, [store, key, label]);
}

/** The registered labels (used by the shell's breadcrumb trail). */
export function useBreadcrumbLabels(): Labels {
  const store = useContext(LabelContext);
  return useSyncExternalStore(
    store?.subscribe ?? (() => () => undefined),
    store?.get ?? (() => empty),
    () => empty,
  );
}
