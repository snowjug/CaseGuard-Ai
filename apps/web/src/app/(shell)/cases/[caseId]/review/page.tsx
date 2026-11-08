import type { Metadata } from 'next';
import { ReviewPage } from '../../../../../features/review/ReviewPage';

export const metadata: Metadata = { title: 'Review' };

export default async function Page({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  return <ReviewPage caseId={caseId} />;
}
