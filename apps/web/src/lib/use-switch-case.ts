'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useCallback } from 'react';
import { useActiveCase } from './active-case';
import { caseIdFromPath } from './nav';
import { writeUrlState } from './url-state';

/**
 * Returns the function that switches the active case from the header or the mobile drawer. It remembers the case,
 * then: on a case page it opens the same section for the new case; on the Command Center it writes `?case=`; elsewhere
 * (the case list, skills, governance...) it only remembers the choice for the case-scoped destinations.
 */
export function useSwitchCase(): (caseId: string) => void {
  const router = useRouter();
  const pathname = usePathname();
  const { setActiveCase } = useActiveCase();
  return useCallback(
    (caseId: string) => {
      setActiveCase(caseId);
      if (caseIdFromPath(pathname)) {
        const section = /^\/cases\/[^/]+(\/.*)?$/.exec(pathname)?.[1] ?? '';
        router.push(`/cases/${encodeURIComponent(caseId)}${section}`);
      } else if (pathname === '/') {
        writeUrlState({ case: caseId });
      }
    },
    [pathname, router, setActiveCase],
  );
}
