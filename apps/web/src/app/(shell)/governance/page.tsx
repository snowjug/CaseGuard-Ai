import type { Metadata } from 'next';
import { GovernancePage } from '../../../features/governance/GovernancePage';

export const metadata: Metadata = { title: 'Settings and audit' };

export default function Page() {
  return <GovernancePage />;
}
