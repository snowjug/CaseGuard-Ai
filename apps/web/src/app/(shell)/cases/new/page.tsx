import type { Metadata } from 'next';
import { NewCasePage } from '../../../../features/ingestion/NewCasePage';

export const metadata: Metadata = { title: 'Ingest a case' };

export default function Page() {
  return <NewCasePage />;
}
