'use client';

import { RouteError, type RouteErrorProps } from '../components/common/RouteError';

/** Errors outside the shell (for example the design lab). Errors in the root layout itself reach `global-error.tsx`. */
export default function RootError(props: Omit<RouteErrorProps, 'standalone'>) {
  return <RouteError {...props} standalone />;
}
