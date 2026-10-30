'use client';

import { ROLE_LABELS } from '@caseguard/schemas';
import {
  cg,
  isThemeMode,
  layout,
  useReducedMotionPreference,
  useThemeMode,
  type ThemeMode,
} from '@caseguard/ui';
import {
  Button,
  Menu,
  MenuDivider,
  MenuItem,
  MenuItemCheckbox,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
  ToggleButton,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowExitRegular,
  DesktopRegular,
  KeyboardRegular,
  NavigationRegular,
  PersonSwapRegular,
  SearchRegular,
  SlideTextRegular,
  WeatherMoonRegular,
  WeatherSunnyRegular,
} from '@fluentui/react-icons';
import Link from 'next/link';
import { useActiveCase } from '../../lib/active-case';
import { useAuth } from '../../lib/auth/context';
import { DevIdentityBadge } from '../../lib/auth/dev-persona';
import { useSession } from '../../lib/auth/session';
import { GlobalSearch } from '../../lib/global-search/GlobalSearch';
import { usePresentation } from '../../lib/presentation';
import { useShellUi } from '../../lib/shell-ui';
import { useSwitchCase } from '../../lib/use-switch-case';
import { CaseSelect } from '../common/CaseSelect';
import { BrandMark } from './BrandMark';
import { HonestyBar } from './Notices';

const useStyles = makeStyles({
  header: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: `${cg.space[2]} ${cg.space[3]}`,
    minHeight: `${layout.headerHeight}px`,
    padding: `${cg.space[2]} ${cg.space[4]}`,
    backgroundColor: cg.surface,
    borderBottom: `1px solid ${cg.borderSubtle}`,
    '@media (max-width: 719px)': { paddingLeft: cg.space[3], paddingRight: cg.space[3] },
  },
  left: { display: 'flex', alignItems: 'center', gap: cg.space[2], flexShrink: 0 },
  hamburger: {
    display: 'none',
    [`@media (max-width: ${layout.drawerBreakpoint - 1}px)`]: { display: 'inline-flex' },
  },
  brand: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: cg.space[2],
    color: cg.text,
    textDecorationLine: 'none',
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase400,
    letterSpacing: '-0.01em',
  },
  wordmarkAccent: { color: cg.tone.brand.fg },
  searchWrap: {
    flex: '1 1 260px',
    minWidth: 0,
    display: 'flex',
    justifyContent: 'center',
    [`@media (max-width: ${layout.drawerBreakpoint - 1}px)`]: { order: 10, flexBasis: '100%' },
  },
  right: {
    display: 'flex',
    alignItems: 'center',
    gap: cg.space[1],
    marginLeft: 'auto',
    flexShrink: 0,
    flexWrap: 'wrap',
  },
  caseSelect: { [`@media (max-width: ${layout.drawerBreakpoint - 1}px)`]: { display: 'none' } },
  // Fluent buttons are at least 96 px wide; once only the icon shows they shrink so the header stays on one row.
  paletteButton: {
    '@media (max-width: 1359px)': {
      minWidth: '32px',
      paddingLeft: cg.space[2],
      paddingRight: cg.space[2],
    },
  },
  presentButton: {
    '@media (max-width: 1279px)': {
      minWidth: '32px',
      paddingLeft: cg.space[2],
      paddingRight: cg.space[2],
    },
  },
  personaButton: {
    '@media (max-width: 1279px)': {
      minWidth: '32px',
      paddingLeft: cg.space[1],
      paddingRight: cg.space[1],
    },
  },
  // Below this width only the icon shows, but the word stays in the accessible name (visually hidden, not removed).
  paletteText: {
    [`@media (max-width: 1359px)`]: {
      position: 'absolute',
      width: '1px',
      height: '1px',
      overflow: 'hidden',
      clipPath: 'inset(50%)',
      whiteSpace: 'nowrap',
    },
  },
  kbd: {
    marginLeft: cg.space[2],
    padding: '0 6px',
    borderRadius: cg.radius.sm,
    border: `1px solid ${cg.borderControl}`,
    fontSize: tokens.fontSizeBase200,
    color: cg.textSecondary,
    fontFamily: cg.font.mono,
    [`@media (max-width: 1359px)`]: { display: 'none' },
  },
  presentText: {
    [`@media (max-width: 1279px)`]: {
      position: 'absolute',
      width: '1px',
      height: '1px',
      overflow: 'hidden',
      clipPath: 'inset(50%)',
      whiteSpace: 'nowrap',
    },
  },
  persona: { display: 'inline-flex', alignItems: 'center', gap: cg.space[2] },
  initials: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '28px',
    height: '28px',
    borderRadius: cg.radius.pill,
    backgroundColor: cg.tone.brand.solid,
    color: cg.tone.brand.onSolid,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    // Drawn from an attribute, so the initials are not text content that must also appear in the button's name.
    '::before': { content: 'attr(data-initials)' },
  },
  personaName: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    lineHeight: 1.2,
    [`@media (max-width: 1279px)`]: {
      position: 'absolute',
      width: '1px',
      height: '1px',
      overflow: 'hidden',
      clipPath: 'inset(50%)',
      whiteSpace: 'nowrap',
    },
  },
  personaRole: {
    fontSize: tokens.fontSizeBase200,
    color: cg.textSecondary,
    fontWeight: tokens.fontWeightRegular,
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

const THEME_LABEL: Record<ThemeMode, string> = { light: 'Light', dark: 'Dark', system: 'System' };

function ThemeMenu() {
  const { mode, setMode } = useThemeMode();
  const Icon =
    mode === 'light' ? WeatherSunnyRegular : mode === 'dark' ? WeatherMoonRegular : DesktopRegular;
  return (
    <Menu
      checkedValues={{ theme: [mode] }}
      onCheckedValueChange={(_event, data) => {
        const next = data.checkedItems[0];
        if (isThemeMode(next)) setMode(next);
      }}
    >
      <MenuTrigger disableButtonEnhancement>
        <Button
          appearance="subtle"
          icon={<Icon />}
          aria-label={`Theme: ${THEME_LABEL[mode]}`}
          title={`Theme: ${THEME_LABEL[mode]}`}
        />
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuItemRadio name="theme" value="light" icon={<WeatherSunnyRegular />}>
            Light
          </MenuItemRadio>
          <MenuItemRadio name="theme" value="dark" icon={<WeatherMoonRegular />}>
            Dark
          </MenuItemRadio>
          <MenuItemRadio name="theme" value="system" icon={<DesktopRegular />}>
            Match system
          </MenuItemRadio>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

function PersonaMenu() {
  const styles = useStyles();
  const auth = useAuth();
  const { session, isLoading } = useSession();
  const { enabled: presenting } = usePresentation();
  const [motion, setMotion] = useReducedMotionPreference();
  const { setShortcutsOpen } = useShellUi();

  const needsIdentity = auth.status === 'unauthenticated';
  if (needsIdentity) {
    return (
      <Button
        appearance="primary"
        icon={<PersonSwapRegular />}
        onClick={() => (auth.dev ? auth.dev.openPicker() : void auth.signIn?.())}
      >
        {auth.dev ? 'Choose persona' : 'Sign in'}
      </Button>
    );
  }

  const name =
    session?.user.displayName ?? (isLoading ? 'Loading…' : (auth.dev?.personaId ?? 'Signed in'));
  const role = session?.user.roles[0] ? ROLE_LABELS[session.user.roles[0]] : null;

  return (
    <Menu
      checkedValues={{ settings: motion === 'reduce' ? ['motion'] : [] }}
      onCheckedValueChange={(_event, data) => {
        if (data.name === 'settings')
          setMotion(data.checkedItems.includes('motion') ? 'reduce' : 'system');
      }}
    >
      <MenuTrigger disableButtonEnhancement>
        <Button className={styles.personaButton} appearance="subtle" title="Account and settings">
          <span className={styles.persona}>
            <span className={styles.initials} aria-hidden="true" data-initials={initialsOf(name)} />
            <span className={styles.personaName}>
              <span>{name}</span>
              {role ? <span className={styles.personaRole}>{role}</span> : null}
            </span>
          </span>
        </Button>
      </MenuTrigger>
      <MenuPopover>
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
            <MenuItem icon={<PersonSwapRegular />} onClick={() => auth.dev?.openPicker()}>
              Switch persona…
            </MenuItem>
          ) : null}
          <MenuItemCheckbox name="settings" value="motion" icon={<SlideTextRegular />}>
            Reduce motion
          </MenuItemCheckbox>
          <MenuItem icon={<KeyboardRegular />} onClick={() => setShortcutsOpen(true)}>
            Keyboard shortcuts
          </MenuItem>
          <MenuDivider />
          <MenuItem icon={<ArrowExitRegular />} onClick={() => void auth.signOut()}>
            {auth.mode === 'dev' ? 'Clear development identity' : 'Sign out'}
          </MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}

/** Application header (the page's `banner` landmark): honesty notice, brand, search, case switcher, commands, theme, presentation and account. */
export function Header() {
  const styles = useStyles();
  const { setNavOpen, navOpen, setPaletteOpen } = useShellUi();
  const { caseId } = useActiveCase();
  const presentation = usePresentation();
  const switchCase = useSwitchCase();

  return (
    <header>
      <HonestyBar />
      <div className={styles.header}>
        <div className={styles.left}>
          <Button
            className={styles.hamburger}
            appearance="subtle"
            icon={<NavigationRegular />}
            aria-label="Open navigation"
            aria-expanded={navOpen}
            onClick={() => setNavOpen(true)}
          />
          <Link href="/" className={styles.brand} aria-label="CaseGuard AI, Command Center">
            <BrandMark />
            <span>
              CaseGuard <span className={styles.wordmarkAccent}>AI</span>
            </span>
          </Link>
        </div>
        <div className={styles.searchWrap}>
          <GlobalSearch />
        </div>
        <div className={styles.right}>
          <div className={styles.caseSelect}>
            <CaseSelect value={caseId} onChange={switchCase} ariaLabel="Active case" />
          </div>
          <Button
            className={styles.paletteButton}
            appearance="outline"
            icon={<SearchRegular />}
            onClick={() => setPaletteOpen(true)}
            title="Command palette (Ctrl+K)"
          >
            <span className={styles.paletteText}>Commands</span>
            <kbd className={styles.kbd} aria-hidden="true">
              Ctrl K
            </kbd>
          </Button>
          <ThemeMenu />
          <ToggleButton
            className={styles.presentButton}
            appearance="subtle"
            icon={<SlideTextRegular />}
            checked={presentation.enabled}
            onClick={presentation.toggle}
            title="Presentation mode"
          >
            {/* Visually hidden (not removed) on narrow screens so the button keeps its name. */}
            <span className={styles.presentText}>Present</span>
          </ToggleButton>
          <PersonaMenu />
        </div>
      </div>
    </header>
  );
}
