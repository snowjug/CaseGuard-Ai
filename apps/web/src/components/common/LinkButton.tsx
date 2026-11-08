'use client';

import { useButtonClassName, type ButtonSize, type ButtonVariant } from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';
import { useRouter } from 'next/navigation';
import type { MouseEvent, ReactNode } from 'react';

const useStyles = makeStyles({
  icon: { display: 'inline-flex', fontSize: '1.2em' },
});

type Appearance = 'primary' | 'outline' | 'secondary' | 'subtle' | 'transparent';

const VARIANTS: Record<Appearance, ButtonVariant> = {
  primary: 'primary',
  outline: 'secondary',
  secondary: 'secondary',
  subtle: 'ghost',
  transparent: 'ghost',
};

const SIZES: Record<'small' | 'medium' | 'large', ButtonSize> = {
  small: 'sm',
  medium: 'md',
  large: 'lg',
};

export interface LinkButtonProps {
  /** Internal path (`/cases`) or external URL. Internal paths navigate client-side. */
  href: string;
  children: ReactNode;
  appearance?: Appearance;
  size?: 'small' | 'medium' | 'large';
  icon?: ReactNode;
  iconPosition?: 'before' | 'after';
  className?: string;
  title?: string;
  'aria-label'?: string;
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
 * A button-looking link (`<a href>`): it opens in a new tab on middle-click or Ctrl+click and is announced as a link,
 * while a plain click navigates with the router instead of reloading the page. Use it for "go to" actions; use `Button`
 * for actions that change data.
 */
export function LinkButton({
  href,
  children,
  appearance = 'outline',
  size = 'medium',
  icon,
  iconPosition = 'before',
  className,
  ...rest
}: LinkButtonProps) {
  const router = useRouter();
  const styles = useStyles();
  const external = isExternal(href);
  const classes = useButtonClassName(
    { variant: VARIANTS[appearance], size: SIZES[size] },
    className,
  );
  const mark = icon ? (
    <span aria-hidden="true" className={styles.icon}>
      {icon}
    </span>
  ) : null;
  return (
    <a
      {...rest}
      href={href}
      className={classes}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (external || !isPlainClick(event)) return;
        event.preventDefault();
        router.push(href);
      }}
    >
      {iconPosition === 'before' ? mark : null}
      {children}
      {iconPosition === 'after' ? mark : null}
    </a>
  );
}
