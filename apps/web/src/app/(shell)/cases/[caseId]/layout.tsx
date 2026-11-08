import type { ReactNode } from 'react';
import { CaseChrome } from '../../../../features/cases/CaseChrome';

/** Every page of a case (review, score, evidence, what if, timeline, ...) sits under the same case header and tabs. */
export default async function CaseLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ caseId: string }>;
}) {
  const { caseId } = await params;
  return <CaseChrome caseId={caseId}>{children}</CaseChrome>;
}
