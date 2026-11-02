import type { Metadata } from 'next';
import { ReportPage } from '../../../../../features/review/report/ReportPage';

export const metadata: Metadata = { title: 'Guided Review Report' };

export default async function Page({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  return <ReportPage caseId={caseId} />;
}
