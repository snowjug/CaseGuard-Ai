import type { Metadata } from 'next';
import { CaseQualityPage } from '../../../../../features/quality/CaseQualityPage';

export const metadata: Metadata = { title: 'Case Quality Review' };

export default async function Page({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  return <CaseQualityPage caseId={caseId} />;
}
