'use client';

import {
  BentoGrid,
  BentoItem,
  BlurFade,
  Badge,
  Button,
  ButtonLink,
  Card,
  PageHeader,
  ThemeToggle,
  UiLink,
  cg,
  useReducedMotionPreference,
  type ToneName,
} from '@caseguard/ui';
import { Switch, makeStyles, tokens } from '@fluentui/react-components';
import {
  ActivityIcon,
  ChevronRightIcon,
  CirclePlayIcon,
  GaugeIcon,
  KeyboardIcon,
  LayersIcon,
  PaletteIcon,
  PresentationIcon,
  Settings2Icon,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { usePresentation } from '../../lib/presentation';
import { useNavBadges, type NavBadge } from '../../lib/nav-badges';
import { useShellUi } from '../../lib/shell-ui';
import { useSingleKeyToggle } from '../../lib/shortcuts/use-single-key-toggle';

const useStyles = makeStyles({
  viewCard: {
    height: '100%',
    boxSizing: 'border-box',
    justifyContent: 'space-between',
    gap: cg.space[6],
    textDecorationLine: 'none',
    color: cg.text,
  },
  tile: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '40px',
    height: '40px',
    borderRadius: cg.radius.md,
    backgroundColor: cg.tone.brand.tint,
    color: cg.tone.brand.fg,
    fontSize: tokens.fontSizeBase500,
  },
  viewText: { display: 'flex', flexDirection: 'column', gap: cg.space[1] },
  badge: { position: 'absolute', top: cg.space[6], insetInlineEnd: cg.space[6] },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.01em',
  },
  text: { margin: 0, color: cg.textSecondary, fontSize: tokens.fontSizeBase300 },
  open: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: cg.space[1],
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightMedium,
  },
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[4],
    height: '100%',
    boxSizing: 'border-box',
  },
  panelHead: { display: 'flex', alignItems: 'center', gap: cg.space[3] },
  setting: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: cg.space[2],
  },
  settingLabel: { display: 'flex', flexDirection: 'column', gap: '2px' },
  settingName: { fontWeight: tokens.fontWeightMedium, fontSize: tokens.fontSizeBase300 },
  settingHelp: { color: cg.textSecondary, fontSize: tokens.fontSizeBase200 },
  buttons: { display: 'flex', flexWrap: 'wrap', gap: cg.space[2] },
});

interface ViewLink {
  href: string;
  title: string;
  description: string;
  icon: LucideIcon;
  /** The key of the figure shown on the card (see `useNavBadges`). */
  badge?: 'demo' | 'system';
}

const VIEWS: readonly ViewLink[] = [
  {
    href: '/governance',
    title: 'Settings and audit',
    description: 'Model, scoring, redaction, roles and the audit log.',
    icon: Settings2Icon,
  },
  {
    href: '/efficiency',
    title: 'Usage and cost',
    description: 'What the analysis spends, and where it could spend less.',
    icon: GaugeIcon,
  },
  {
    href: '/system',
    title: 'System status',
    description: 'Whether the services behind the review are healthy.',
    icon: ActivityIcon,
    badge: 'system',
  },
  {
    href: '/demo',
    title: 'Guided demo',
    description: 'A short walk through the product with presenter notes.',
    icon: CirclePlayIcon,
    badge: 'demo',
  },
];

const BADGE_TONE: Record<NavBadge['tone'], ToneName> = {
  neutral: 'neutral',
  warning: 'uncertain',
  danger: 'unsupported',
};

function ViewCard({ view, badge }: { view: ViewLink; badge: NavBadge | undefined }) {
  const styles = useStyles();
  const Icon = view.icon;
  return (
    <Card as={UiLink} href={view.href} interactive className={styles.viewCard}>
      <span className={styles.tile} aria-hidden="true">
        <Icon />
      </span>
      <span className={styles.viewText}>
        <h2 className={styles.title}>{view.title}</h2>
        <span className={styles.text}>{view.description}</span>
      </span>
      {badge ? (
        <span className={styles.badge}>
          <Badge tone={BADGE_TONE[badge.tone]} size="sm">
            {view.badge === 'demo' ? badge.description : badge.text}
          </Badge>
        </span>
      ) : null}
      <span className={styles.open} aria-hidden="true">
        Open <ChevronRightIcon />
      </span>
    </Card>
  );
}

function Setting({ name, help, children }: { name: string; help: string; children: ReactNode }) {
  const styles = useStyles();
  return (
    <div className={styles.setting}>
      <span className={styles.settingLabel}>
        <span className={styles.settingName}>{name}</span>
        <span className={styles.settingHelp}>{help}</span>
      </span>
      {children}
    </div>
  );
}

/** The home of everything that is not the daily work: the admin views, plus the appearance and keyboard preferences. */
export function AdvancedPage() {
  const styles = useStyles();
  const [motion, setMotion] = useReducedMotionPreference();
  const singleKey = useSingleKeyToggle();
  const presentation = usePresentation();
  const { setShortcutsOpen } = useShellUi();
  const { badges } = useNavBadges({ demo: true });
  return (
    <>
      <PageHeader
        title="Advanced"
        description="Settings, audit and developer views."
        actions={
          // The gallery of components only exists outside production builds.
          process.env.NODE_ENV === 'production' ? undefined : (
            <ButtonLink href="/design-lab" variant="ghost" icon={<LayersIcon />}>
              Design lab
            </ButtonLink>
          )
        }
      />
      <BentoGrid>
        {VIEWS.map((view, index) => (
          <BentoItem key={view.href} span={12} spanSm={6} spanLg={3}>
            <BlurFade index={index} className={styles.panel}>
              <ViewCard view={view} badge={view.badge ? badges[view.badge] : undefined} />
            </BlurFade>
          </BentoItem>
        ))}
        <BentoItem span={12} spanLg={6}>
          <BlurFade index={4} className={styles.panel}>
            <Card className={styles.panel} aria-labelledby="advanced-appearance">
              <div className={styles.panelHead}>
                <span className={styles.tile} aria-hidden="true">
                  <PaletteIcon />
                </span>
                <h2 id="advanced-appearance" className={styles.title}>
                  Appearance
                </h2>
              </div>
              <Setting name="Theme" help="Light, dark, or follow your device.">
                <ThemeToggle />
              </Setting>
              <Setting name="Reduce motion" help="Turns off animation across the app.">
                <Switch
                  aria-label="Reduce motion"
                  checked={motion === 'reduce'}
                  onChange={(_event, data) => setMotion(data.checked ? 'reduce' : 'system')}
                />
              </Setting>
            </Card>
          </BlurFade>
        </BentoItem>
        <BentoItem span={12} spanLg={6}>
          <BlurFade index={5} className={styles.panel}>
            <Card className={styles.panel} aria-labelledby="advanced-keyboard">
              <div className={styles.panelHead}>
                <span className={styles.tile} aria-hidden="true">
                  <KeyboardIcon />
                </span>
                <h2 id="advanced-keyboard" className={styles.title}>
                  Keyboard and presenting
                </h2>
              </div>
              <Setting name="Single-key shortcuts" help="Keys such as / and G then C.">
                <Switch
                  aria-label="Single-key shortcuts"
                  checked={singleKey.enabled}
                  onChange={(_event, data) => singleKey.set(data.checked)}
                />
              </Setting>
              <div className={styles.buttons}>
                <Button
                  variant="secondary"
                  icon={<KeyboardIcon />}
                  onClick={() => setShortcutsOpen(true)}
                >
                  Show keyboard shortcuts
                </Button>
                <Button
                  variant="secondary"
                  icon={<PresentationIcon />}
                  onClick={() => presentation.toggle()}
                >
                  {presentation.enabled
                    ? 'Turn off presentation mode'
                    : 'Turn on presentation mode'}
                </Button>
              </div>
            </Card>
          </BlurFade>
        </BentoItem>
      </BentoGrid>
    </>
  );
}
