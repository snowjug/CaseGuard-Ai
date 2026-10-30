import type { Metadata } from 'next';
import { CasesPage } from '../../../features/cases/CasesPage';

export const metadata: Metadata = { title: 'Cases' };

export default function Page() {
  return <CasesPage />;
}
