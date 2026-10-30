'use client';

import {
  createContext,
  createElement,
  forwardRef,
  useContext,
  type AnchorHTMLAttributes,
  type ComponentType,
  type ReactNode,
} from 'react';

export interface UiLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  href: string;
}

/** A component that renders a link; the web app injects a router-aware implementation (next/link). */
export type UiLinkComponent = ComponentType<UiLinkProps>;

const isExternal = (href: string): boolean => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href);

const DefaultLink = forwardRef<HTMLAnchorElement, UiLinkProps>(function DefaultLink(
  { href, rel, target, children, ...rest },
  ref,
) {
  const external = isExternal(href);
  return (
    <a
      ref={ref}
      href={href}
      target={target ?? (external ? '_blank' : undefined)}
      rel={rel ?? (external ? 'noopener noreferrer' : undefined)}
      {...rest}
    >
      {children}
    </a>
  );
});

const LinkContext = createContext<UiLinkComponent>(DefaultLink);

/** Lets an app route every link rendered by `@caseguard/ui` through its client-side router. */
export function UiLinkProvider({
  component,
  children,
}: {
  component: UiLinkComponent;
  children: ReactNode;
}) {
  return <LinkContext.Provider value={component}>{children}</LinkContext.Provider>;
}

/** Link used by every primitive in this package (breadcrumbs, metric evidence links, empty-state actions). */
export function UiLink(props: UiLinkProps) {
  const component = useContext(LinkContext);
  // The component comes from context and is stable across renders; createElement avoids the false positive of
  // the "components created during render" rule for a looked-up component.
  return createElement(component, props);
}
