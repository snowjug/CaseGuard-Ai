import type { Metadata } from 'next';
import { EfficiencyPage } from '../../../features/efficiency/EfficiencyPage';

export const metadata: Metadata = { title: 'Efficiency Monitor' };

export default function Page() {
  return <EfficiencyPage />;
}
