import type { Metadata } from 'next';
import { CaseOverviewPage } from '../../../../features/cases/CaseOverviewPage';

export const metadata: Metadata = { title: 'Case overview' };

export default async function Page({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  return <CaseOverviewPage caseId={caseId} />;
}
