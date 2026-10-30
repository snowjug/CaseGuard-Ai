import type { Metadata } from 'next';
import { DemoGuidePage } from '../../../features/demo/DemoGuidePage';

export const metadata: Metadata = { title: 'Demo Guide' };

export default function Page() {
  return <DemoGuidePage />;
}
