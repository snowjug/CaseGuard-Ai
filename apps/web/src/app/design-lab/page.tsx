import { notFound } from 'next/navigation';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Design lab', robots: { index: false, follow: false } };

/**
 * Development-only design lab. In a production build the route answers 404, so the sample data and the gallery are
 * never reachable (and the lab module is loaded lazily, only after this check).
 */
export default async function DesignLabPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  const { DesignLab } = await import('../../features/design-lab/DesignLab');
  return (
    <>
      <a className="cg-skip-link" href="#main-content">
        Skip to main content
      </a>
      <main id="main-content">
        <DesignLab />
      </main>
    </>
  );
}
