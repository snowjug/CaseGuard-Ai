import type { Metadata } from 'next';
import { AppShell } from '../components/shell/AppShell';
import { NotFoundState } from '../components/common/NotFoundState';

export const metadata: Metadata = { title: 'Page not found' };

/** Unmatched URLs. Rendered inside the shell explicitly because unmatched routes do not pass through `(shell)/layout.tsx`. */
export default function NotFound() {
  return (
    <AppShell>
      <NotFoundState />
    </AppShell>
  );
}
