import type { Metadata } from 'next';
import { CounterfactualLabPage } from '../../../../../features/counterfactual/CounterfactualLabPage';

export const metadata: Metadata = { title: 'Counterfactual Lab' };

export default async function Page({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  return <CounterfactualLabPage caseId={caseId} />;
}
