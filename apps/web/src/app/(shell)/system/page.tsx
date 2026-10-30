import type { Metadata } from 'next';
import { SystemHealthPage } from '../../../features/system/SystemHealthPage';

export const metadata: Metadata = { title: 'System Health' };

export default function Page() {
  return <SystemHealthPage />;
}
