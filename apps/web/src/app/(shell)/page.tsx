import type { Metadata } from 'next';
import { HomePage } from '../../features/home/HomePage';

export const metadata: Metadata = { title: 'Home' };

export default function Page() {
  return <HomePage />;
}
