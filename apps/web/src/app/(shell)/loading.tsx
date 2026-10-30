import { PageSkeleton } from '../../components/common/PageSkeleton';

/** Shown while a page's route segment streams in. Pages show their own skeletons for data loading. */
export default function Loading() {
  return <PageSkeleton />;
}
