'use client';

import { Button, type ButtonProps } from '@fluentui/react-components';
import { useRouter } from 'next/navigation';
import type { MouseEvent, ReactNode } from 'react';

export interface LinkButtonProps extends Pick<
  ButtonProps,
  'appearance' | 'size' | 'shape' | 'icon' | 'iconPosition' | 'className' | 'title' | 'aria-label'
> {
  /** Internal path (`/cases`) or external URL. Internal paths navigate client-side. */
  href: string;
  children: ReactNode;
}

const isExternal = (href: string): boolean => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href);
const isPlainClick = (event: MouseEvent<HTMLElement>): boolean =>
  event.button === 0 &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey &&
  !event.defaultPrevented;

/**
 * A Fluent button that is a real link (`<a href>`): it opens in a new tab on middle-click or Ctrl+click and is announced
 * as a link, while a plain click navigates with the router instead of reloading the page. Use it for "go to" actions;
 * use `Button` for actions that change data.
 */
export function LinkButton({ href, children, ...rest }: LinkButtonProps) {
  const router = useRouter();
  const external = isExternal(href);
  return (
    <Button
      {...rest}
      as="a"
      href={href}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (external || !isPlainClick(event)) return;
        event.preventDefault();
        router.push(href);
      }}
    >
      {children}
    </Button>
  );
}
