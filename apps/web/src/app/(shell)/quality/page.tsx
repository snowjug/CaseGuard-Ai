import type { Metadata } from 'next';
import { PortfolioQualityPage } from '../../../features/quality/PortfolioQualityPage';

export const metadata: Metadata = { title: 'Quality Review' };

export default function Page() {
  return <PortfolioQualityPage />;
}
