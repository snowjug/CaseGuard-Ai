'use client';

import { RouteError, type RouteErrorProps } from '../../components/common/RouteError';

/** Errors inside a product page: the shell (navigation, header) stays usable. */
export default function ShellError(props: Omit<RouteErrorProps, 'standalone'>) {
  return <RouteError {...props} />;
}
