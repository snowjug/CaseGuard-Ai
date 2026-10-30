import type { Metadata } from 'next';
import { CommandCenterPage } from '../../features/command-center/CommandCenterPage';

export const metadata: Metadata = { title: 'Command Center' };

export default function Page() {
  return <CommandCenterPage />;
}
