import type { ReactNode } from 'react';
import { AppShell } from '../../components/shell/AppShell';

/** Every product page lives in this route group so it gets the header, navigation, breadcrumbs and footer. */
export default function ShellLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
