import type { Metadata } from 'next';
import { NewCasePage } from '../../../../features/ingestion/NewCasePage';

export const metadata: Metadata = { title: 'Add a case' };

export default function Page() {
  return <NewCasePage />;
}
