import type { Metadata } from 'next';
import { TimelinePage } from '../../../../../features/timeline/TimelinePage';

export const metadata: Metadata = { title: 'Case Timeline' };

export default async function Page({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  return <TimelinePage caseId={caseId} />;
}
