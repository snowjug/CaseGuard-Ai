'use client';

import { usePathname } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  CASE_COOKIE,
  parseCaseId,
  readCaseCookie as parseCaseCookie,
  serializeCaseCookie,
} from './case-cookie';
import { caseIdFromPath } from './nav';

export { CASE_COOKIE };
const CASE_EVENT = 'cg:active-case';

function readCaseCookie(): string | null {
  return typeof document === 'undefined' ? null : parseCaseCookie(document.cookie);
}

/** Remembers the last case in a first-party `SameSite=Lax` cookie so case-scoped navigation has a target. */
function writeCaseCookie(caseId: string | null): void {
  document.cookie = serializeCaseCookie(caseId);
  window.dispatchEvent(new Event(CASE_EVENT));
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(CASE_EVENT, listener);
  return () => window.removeEventListener(CASE_EVENT, listener);
}

export interface ActiveCaseState {
  /** The active case: the URL's case when on a case page, otherwise the last remembered one. */
  caseId: string | null;
  /** The case id in the URL, if any (the source of truth for case-scoped pages). */
  pathCaseId: string | null;
  /** Remembers a case (cookie). Navigation to its pages is the caller's job (see CaseSwitcher). */
  setActiveCase: (caseId: string | null) => void;
}

const ActiveCaseContext = createContext<ActiveCaseState | null>(null);

/** Tracks the active case. The URL is the source of truth; the cookie only remembers the last case between pages. */
export function ActiveCaseProvider({
  initialCaseId,
  children,
}: {
  initialCaseId: string | null;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const pathCaseId = caseIdFromPath(pathname);
  const remembered = useSyncExternalStore(subscribe, readCaseCookie, () => initialCaseId);

  useEffect(() => {
    // Writing the cookie only notifies subscribers; React state is not touched here.
    if (pathCaseId && pathCaseId !== readCaseCookie() && parseCaseId(pathCaseId))
      writeCaseCookie(pathCaseId);
  }, [pathCaseId]);

  const setActiveCase = useCallback(
    (caseId: string | null) => writeCaseCookie(parseCaseId(caseId)),
    [],
  );
  const value = useMemo<ActiveCaseState>(
    () => ({ caseId: pathCaseId ?? remembered, pathCaseId, setActiveCase }),
    [pathCaseId, remembered, setActiveCase],
  );
  return <ActiveCaseContext.Provider value={value}>{children}</ActiveCaseContext.Provider>;
}

export function useActiveCase(): ActiveCaseState {
  const value = useContext(ActiveCaseContext);
  if (!value) throw new Error('useActiveCase must be used inside <ActiveCaseProvider>');
  return value;
}
