'use client';

import type { UiLinkProps } from '@caseguard/ui';
import NextLink from 'next/link';
import { forwardRef } from 'react';

const isExternal = (href: string): boolean => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href);

/** Routes every `@caseguard/ui` link through the Next.js router (client-side navigation, prefetching). */
export const NextLinkAdapter = forwardRef<HTMLAnchorElement, UiLinkProps>(function NextLinkAdapter(
  { href, children, rel, target, ...rest },
  ref,
) {
  if (isExternal(href)) {
    return (
      <a
        ref={ref}
        href={href}
        target={target ?? '_blank'}
        rel={rel ?? 'noopener noreferrer'}
        {...rest}
      >
        {children}
      </a>
    );
  }
  return (
    <NextLink
      ref={ref}
      href={href}
      {...(target ? { target } : {})}
      {...(rel ? { rel } : {})}
      {...rest}
    >
      {children}
    </NextLink>
  );
});
