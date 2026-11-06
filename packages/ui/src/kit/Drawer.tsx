'use client';

import {
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  OverlayDrawer,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { XIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { cg } from '../tokens/cg';
import { layout } from '../tokens/static';
import { IconButton } from './Button';

const useStyles = makeStyles({
  surface: {
    backgroundColor: cg.surfaceRaised,
    color: cg.text,
    border: `1px solid ${cg.glassBorder}`,
    boxShadow: cg.shadowHigh,
    maxWidth: '100vw',
  },
  side: { borderRadius: `${cg.radius.xl} 0 0 ${cg.radius.xl}` },
  sheet: { borderRadius: `${cg.radius.xl} ${cg.radius.xl} 0 0`, height: 'min(85dvh, 720px)' },
  header: { paddingBottom: cg.space[3] },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase500,
    lineHeight: tokens.lineHeightBase500,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.015em',
  },
  subtitle: {
    margin: `${cg.space[1]} 0 0`,
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase300,
  },
  body: { display: 'flex', flexDirection: 'column', gap: cg.space[4] },
  footer: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: cg.space[2],
    padding: `${cg.space[3]} ${cg.space[6]} ${cg.space[6]}`,
  },
});

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  subtitle?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** Width on a wide screen: 400, 560 or 720 px. On a phone the drawer is a bottom sheet instead. */
  size?: 'sm' | 'md' | 'lg';
}

const WIDTH = { sm: 400, md: 560, lg: 720 } as const;

/**
 * A panel for the details of one item (an evidence quotation, a claim, an event): it slides in from the right on a wide
 * screen and rises from the bottom as a sheet on a phone. Modal: focus is trapped, Escape closes, focus returns.
 */
export function Drawer({
  open,
  onOpenChange,
  title,
  subtitle,
  children,
  footer,
  size = 'md',
}: DrawerProps) {
  const styles = useStyles();
  const sheet = useMediaQuery(`(max-width: ${layout.drawerBreakpoint - 1}px)`, false);
  return (
    <OverlayDrawer
      open={open}
      position={sheet ? 'bottom' : 'end'}
      modalType="modal"
      className={mergeClasses(styles.surface, sheet ? styles.sheet : styles.side)}
      style={sheet ? undefined : { width: `min(100vw, ${WIDTH[size]}px)` }}
      onOpenChange={(_event, data) => onOpenChange(data.open)}
    >
      <DrawerHeader className={styles.header}>
        <DrawerHeaderTitle
          action={
            <IconButton
              icon={<XIcon />}
              label="Close"
              size="sm"
              tooltip={false}
              onClick={() => onOpenChange(false)}
            />
          }
        >
          <span className={styles.title}>{title}</span>
          {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody className={styles.body}>{children}</DrawerBody>
      {footer ? <div className={styles.footer}>{footer}</div> : null}
    </OverlayDrawer>
  );
}
