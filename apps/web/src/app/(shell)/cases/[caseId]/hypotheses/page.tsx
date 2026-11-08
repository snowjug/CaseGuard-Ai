import type { Metadata } from 'next';
import { HypothesisArenaPage } from '../../../../../features/hypotheses/HypothesisArenaPage';

export const metadata: Metadata = { title: 'Possible causes' };

export default async function Page({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  return <HypothesisArenaPage caseId={caseId} />;
}
