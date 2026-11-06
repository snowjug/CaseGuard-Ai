'use client';

import { ROLE_LABELS } from '@caseguard/schemas';
import { Button, cg, layout, useReducedMotionPreference } from '@caseguard/ui';
import {
  Menu,
  MenuDivider,
  MenuItem,
  MenuItemCheckbox,
  MenuList,
  MenuPopover,
  MenuTrigger,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { KeyboardIcon, LogOutIcon, PresentationIcon, UserCogIcon, WindIcon } from 'lucide-react';
import { useAuth } from '../../lib/auth/context';
import { DevIdentityBadge } from '../../lib/auth/dev-persona';
import { useSession } from '../../lib/auth/session';
import { usePresentation } from '../../lib/presentation';
import { useShellUi } from '../../lib/shell-ui';

const useStyles = makeStyles({
  trigger: {
    width: '100%',
    justifyContent: 'flex-start',
    minHeight: '48px',
    paddingInline: cg.space[2],
    textAlign: 'start',
  },
  triggerCompact: {
    width: 'auto',
    minWidth: '44px',
    minHeight: '40px',
    paddingInline: cg.space[1],
    justifyContent: 'center',
  },
  persona: { display: 'inline-flex', alignItems: 'center', gap: cg.space[2], minWidth: 0 },
  initials: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: '32px',
    height: '32px',
    borderRadius: cg.radius.pill,
    backgroundImage: cg.gradientAccent,
    color: cg.tone.brand.onSolid,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    // Drawn from an attribute, so the initials are not text content that must also appear in the button's name.
    '::before': { content: 'attr(data-initials)' },
  },
  name: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    minWidth: 0,
    lineHeight: 1.25,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
  },
  nameText: {
    maxWidth: '132px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  role: {
    maxWidth: '132px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: tokens.fontWeightRegular,
    color: cg.textSecondary,
  },
  // Visually hidden, not removed: the button keeps its name when only the avatar shows.
  hidden: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
  },
  hiddenInRail: {
    [`@media (max-width: ${layout.railBreakpoint - 1}px)`]: {
      position: 'absolute',
      width: '1px',
      height: '1px',
      overflow: 'hidden',
      clipPath: 'inset(50%)',
      whiteSpace: 'nowrap',
    },
  },
  popover: {
    padding: cg.space[1],
    borderRadius: cg.radius.md,
    backgroundColor: cg.surfaceRaised,
    border: `1px solid ${cg.glassBorder}`,
    boxShadow: cg.shadowHigh,
  },
  menuHead: {
    padding: `${cg.space[2]} ${cg.space[3]}`,
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    maxWidth: '280px',
  },
  menuName: { fontWeight: tokens.fontWeightSemibold },
  menuMeta: { fontSize: tokens.fontSizeBase200, color: cg.textSecondary, overflowWrap: 'anywhere' },
});

const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('') || '?';

export interface AccountMenuProps {
  /** Only the avatar shows (the name and role stay in the accessible name). */
  compact?: boolean;
  /** Below this width the name and role are visually hidden too (the sidebar rail). */
  railHidesText?: boolean;
}

/**
 * Who is signed in, and the few personal controls: switch the demo persona, reduce motion, presentation mode, keyboard
 * shortcuts and sign out. Without an identity it is the one thing to click: choose a persona or sign in.
 */
export function AccountMenu({ compact = false, railHidesText = false }: AccountMenuProps) {
  const styles = useStyles();
  const auth = useAuth();
  const { session, isLoading } = useSession();
  const { enabled: presenting, toggle: togglePresentation } = usePresentation();
  const [motion, setMotion] = useReducedMotionPreference();
  const { setShortcutsOpen } = useShellUi();

  if (auth.status === 'unauthenticated') {
    const label = auth.dev ? 'Choose persona' : 'Sign in';
    return (
      <Button
        variant="primary"
        icon={<UserCogIcon />}
        fullWidth={!compact}
        onClick={() => (auth.dev ? auth.dev.openPicker() : void auth.signIn?.())}
      >
        <span className={compact ? styles.hidden : undefined}>{label}</span>
      </Button>
    );
  }

  const name =
    session?.user.displayName ??
    (isLoading || auth.status === 'loading' ? 'Loading…' : (auth.dev?.personaId ?? 'Signed in'));
  const role = session?.user.roles[0] ? ROLE_LABELS[session.user.roles[0]] : null;
  const settings = [...(motion === 'reduce' ? ['motion'] : []), ...(presenting ? ['present'] : [])];

  return (
    <Menu
      checkedValues={{ settings }}
      onCheckedValueChange={(_event, data) => {
        if (data.name !== 'settings') return;
        setMotion(data.checkedItems.includes('motion') ? 'reduce' : 'system');
        if (data.checkedItems.includes('present') !== presenting) togglePresentation();
      }}
    >
      <MenuTrigger disableButtonEnhancement>
        <Button
          variant="ghost"
          className={mergeClasses(styles.trigger, compact && styles.triggerCompact)}
          title="Account and settings"
        >
          <span className={styles.persona}>
            <span className={styles.initials} aria-hidden="true" data-initials={initialsOf(name)} />
            <span
              className={mergeClasses(
                styles.name,
                compact && styles.hidden,
                railHidesText && styles.hiddenInRail,
              )}
            >
              <span className={styles.nameText}>{name}</span>
              {role ? <span className={styles.role}>{role}</span> : null}
            </span>
          </span>
        </Button>
      </MenuTrigger>
      <MenuPopover className={styles.popover}>
        <div className={styles.menuHead}>
          <span className={styles.menuName}>{name}</span>
          {role ? <span className={styles.menuMeta}>{role}</span> : null}
          {session?.tenant ? (
            <span className={styles.menuMeta}>Tenant: {session.tenant.name}</span>
          ) : null}
          {auth.mode === 'dev' && !presenting ? <DevIdentityBadge /> : null}
        </div>
        <MenuDivider />
        <MenuList>
          {auth.dev && !presenting ? (
            <MenuItem icon={<UserCogIcon />} onClick={() => auth.dev?.openPicker()}>
              Switch persona…
            </MenuItem>
          ) : null}
          <MenuItemCheckbox
            name="settings"
            value="motion"
            icon={<WindIcon />}
            persistOnClick={false}
          >
            Reduce motion
          </MenuItemCheckbox>
          <MenuItemCheckbox
            name="settings"
            value="present"
            icon={<PresentationIcon />}
            persistOnClick={false}
          >
            Presentation mode
          </MenuItemCheckbox>
          <MenuItem icon={<KeyboardIcon />} onClick={() => setShortcutsOpen(true)}>
            Keyboard shortcuts
          </MenuItem>
          <MenuDivider />
          <MenuItem icon={<LogOutIcon />} onClick={() => void auth.signOut()}>
            {auth.mode === 'dev' ? 'Clear development identity' : 'Sign out'}
          </MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}
