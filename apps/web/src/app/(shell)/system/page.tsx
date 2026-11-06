import type { Metadata } from 'next';
import { SystemHealthPage } from '../../../features/system/SystemHealthPage';

export const metadata: Metadata = { title: 'System status' };

export default function Page() {
  return <SystemHealthPage />;
}
