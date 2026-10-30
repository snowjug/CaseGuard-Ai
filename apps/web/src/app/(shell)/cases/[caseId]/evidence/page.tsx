import type { Metadata } from 'next';
import { EvidenceLedgerPage } from '../../../../../features/evidence/EvidenceLedgerPage';

export const metadata: Metadata = { title: 'Evidence Ledger' };

export default async function Page({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  return <EvidenceLedgerPage caseId={caseId} />;
}
