'use client';

import {
  Accordion,
  AccordionItem,
  AnimatedList,
  Badge,
  BentoGrid,
  BentoItem,
  Button,
  ButtonLink,
  Card,
  Dialog,
  Drawer,
  Field,
  IconButton,
  Input,
  Logo,
  SectionHeader,
  SegmentedControl,
  Select,
  Skeleton,
  SkeletonText,
  StatCard,
  TabNav,
  TabPanel,
  Tabs,
  Textarea,
  ThemeToggle,
  Tooltip,
  cg,
  formatNumber,
} from '@caseguard/ui';
import { makeStyles } from '@fluentui/react-components';
import {
  ArrowRightIcon,
  CopyIcon,
  GitForkIcon,
  InfoIcon,
  PlusIcon,
  SearchIcon,
  SparklesIcon,
  Trash2Icon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: cg.space[8] },
  block: { display: 'flex', flexDirection: 'column', gap: cg.space[4] },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[3] },
  label: { margin: 0, fontSize: '13px', color: cg.textMuted },
  fields: {
    display: 'grid',
    gap: cg.space[4],
    gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
  },
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[3] },
  fix: { display: 'flex', alignItems: 'center', gap: cg.space[3], padding: `${cg.space[3]} 0` },
  fixText: { flex: '1 1 auto', minWidth: 0 },
});

function Group({ title, children }: { title: string; children: ReactNode }) {
  const styles = useStyles();
  return (
    <div className={styles.block}>
      <p className={styles.label}>{title}</p>
      {children}
    </div>
  );
}

const FIXES = [
  { id: 'logs', title: 'Ask for the diagnostic logs earlier', gain: '+6' },
  { id: 'dns', title: 'Rule out the DNS cache before reinstalling', gain: '+4' },
  { id: 'scope', title: 'Confirm how many users are affected', gain: '+3' },
] as const;

/**
 * The redesign's component kit with static sample props: buttons, badges, cards and the bento grid, tabs and
 * segmented controls, disclosure, overlays, form fields, loading placeholders and motion. Open it in light and dark,
 * tab through it, and run an accessibility scan.
 */
export function KitGallery() {
  const styles = useStyles();
  const [tab, setTab] = useState('review');
  const [source, setSource] = useState<'paste' | 'upload' | 'sample'>('paste');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [fixes, setFixes] = useState<readonly (typeof FIXES)[number][]>(FIXES);

  return (
    <div className={styles.root}>
      <SectionHeader
        id="kit-title"
        title="Kit"
        description="The building blocks of every screen. One accent, glass cards, one icon set, motion under 300 ms."
      />

      <Group title="Buttons: one primary per screen, with a glint on hover or focus">
        <div className={styles.row}>
          <Button variant="primary" icon={<PlusIcon />}>
            Add a case
          </Button>
          <Button variant="secondary" icon={<CopyIcon />}>
            Copy fix list
          </Button>
          <Button variant="ghost">Cancel</Button>
          <Button variant="danger" icon={<Trash2Icon />}>
            Delete case
          </Button>
          <Button variant="primary" loading>
            Creating
          </Button>
          <Button variant="secondary" disabledFocusable>
            Run the review
          </Button>
          <ButtonLink
            href="#kit-title"
            variant="secondary"
            icon={<ArrowRightIcon />}
            iconPosition="end"
          >
            Open review
          </ButtonLink>
        </div>
        <div className={styles.row}>
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg" variant="primary">
            Large
          </Button>
          <IconButton icon={<CopyIcon />} label="Copy fix" />
          <IconButton icon={<SearchIcon />} label="Search" variant="secondary" />
          <Tooltip content="Share of effort a better step would have avoided">
            <Button variant="ghost" icon={<InfoIcon />}>
              Time that could have been saved
            </Button>
          </Tooltip>
        </div>
      </Group>

      <Group title="Badges: status colours carry an icon and a word">
        <div className={styles.row}>
          <Badge tone="productive" icon={<SparklesIcon />}>
            Good
          </Badge>
          <Badge tone="uncertain">Needs work</Badge>
          <Badge tone="unsupported">Poor</Badge>
          <Badge tone="brand">Skill</Badge>
          <Badge tone="neutral">12 events</Badge>
          <Badge tone="simulated" dashed icon={<GitForkIcon />}>
            Simulation, not history
          </Badge>
          <Badge tone="neutral" dotted>
            Estimated
          </Badge>
        </div>
      </Group>

      <Group title="Cards and the bento grid">
        <BentoGrid>
          <BentoItem span={12} spanSm={12} spanLg={7}>
            <Card glow hero padding="lg">
              <SectionHeader
                level={3}
                title="Hero card"
                description="A soft glow sits behind the one key result of a screen."
              />
              <Skeleton height={48} width="40%" />
            </Card>
          </BentoItem>
          <BentoItem span={12} spanSm={6} spanLg={5}>
            <StatCard
              label="Time that could have been saved"
              value={58}
              unit="%"
              status="unsupported"
              statusLabel="High"
              delta={{ text: '+4 points since the last case', judgement: 'worsening' }}
              help="The share of effort a better-supported step would have avoided. It is an estimate with a range."
              headingLevel={4}
            />
          </BentoItem>
          <BentoItem span={12} spanSm={6} spanLg={4}>
            <StatCard
              label="Cases reviewed"
              value={1280}
              format={(n) => formatNumber(n, { maximumFractionDigits: 0 })}
              status="productive"
              statusLabel="On track"
              headingLevel={4}
            />
          </BentoItem>
          <BentoItem span={12} spanSm={6} spanLg={4}>
            <Card as="a" href="#kit-title" interactive>
              <strong>An interactive card</strong>
              <span>It lifts 2 px on hover and is a real link.</span>
            </Card>
          </BentoItem>
          <BentoItem span={12} spanSm={6} spanLg={4}>
            <Card flat>
              <strong>A flat card</strong>
              <span>Solid surface, for long lists.</span>
            </Card>
          </BentoItem>
        </BentoGrid>
      </Group>

      <Group title="Tabs, page tabs and segmented controls">
        <Tabs
          aria-label="Review sections"
          value={tab}
          onValueChange={setTab}
          items={[
            { value: 'review', label: 'Review' },
            { value: 'score', label: 'Score', badge: <Badge size="sm">36</Badge> },
            { value: 'evidence', label: 'Evidence' },
          ]}
        >
          <TabPanel value="review">The verdict and the top fixes.</TabPanel>
          <TabPanel value="score">How the score was built.</TabPanel>
          <TabPanel value="evidence">What each claim is based on.</TabPanel>
        </Tabs>
        <TabNav
          aria-label="Case pages (links)"
          items={[
            { href: '#kit-review', label: 'Review', active: true },
            { href: '#kit-evidence', label: 'Evidence', active: false },
            { href: '#kit-what-if', label: 'What if', active: false },
            { href: '#kit-timeline', label: 'Timeline', active: false },
          ]}
        />
        <div className={styles.row}>
          <SegmentedControl
            aria-label="How to add the case"
            value={source}
            onValueChange={setSource}
            options={[
              { value: 'paste', label: 'Paste' },
              { value: 'upload', label: 'Upload' },
              { value: 'sample', label: 'Sample' },
            ]}
          />
          <ThemeToggle />
          <ThemeToggle variant="icon" />
        </div>
      </Group>

      <Group title="Disclosure">
        <Accordion>
          <AccordionItem
            title="What is still missing"
            subtitle="3 open requirements"
            badge={<Badge>3</Badge>}
          >
            Exact failure timestamps, the client error code and the number of affected users.
          </AccordionItem>
          <AccordionItem title="How this was calculated">
            Six quality dimensions are weighted, then capped penalties are subtracted.
          </AccordionItem>
        </Accordion>
      </Group>

      <Group title="Overlays">
        <div className={styles.row}>
          <Button onClick={() => setDialogOpen(true)}>Open a dialog</Button>
          <Button onClick={() => setDrawerOpen(true)}>Open a drawer</Button>
        </div>
        <Dialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          title="Delete this case?"
          description="The case and its review are removed for everyone in this workspace."
          actions={
            <>
              <Button variant="ghost" onClick={() => setDialogOpen(false)}>
                Keep it
              </Button>
              <Button variant="danger" onClick={() => setDialogOpen(false)}>
                Delete case
              </Button>
            </>
          }
        />
        <Drawer
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          title="Evidence"
          subtitle="Quoted from the customer chat, 9 Mar 2026"
        >
          <Card flat>
            The customer said the sign-in error started right after the policy update.
          </Card>
        </Drawer>
      </Group>

      <Group title="Form fields">
        <div className={styles.fields}>
          <Field label="Search" hint="Reference, title or customer">
            <Input startIcon={<SearchIcon />} placeholder="CG-SYN-1001" />
          </Field>
          <Field label="Title" error="Use at least 5 characters." required>
            <Input defaultValue="Hi" />
          </Field>
          <Field label="Workload">
            <Select defaultValue="">
              <option value="">Any workload</option>
              <option value="teams">Microsoft Teams</option>
              <option value="exchange">Exchange Online</option>
            </Select>
          </Field>
          <Field label="Case text" hint="Paste the whole conversation.">
            <Textarea rows={4} />
          </Field>
        </div>
      </Group>

      <Group title="Loading placeholders and motion">
        <Card>
          <div className={styles.stack}>
            <Skeleton width="30%" height={18} />
            <SkeletonText lines={3} />
          </div>
        </Card>
        <Card>
          <AnimatedList
            aria-label="Top fixes"
            items={fixes}
            getKey={(fix) => fix.id}
            renderItem={(fix) => (
              <div className={styles.fix}>
                <span className={styles.fixText}>{fix.title}</span>
                <Badge tone="productive">{fix.gain} points</Badge>
                <IconButton
                  icon={<Trash2Icon />}
                  label={`Remove: ${fix.title}`}
                  size="sm"
                  onClick={() =>
                    setFixes((current) => current.filter((item) => item.id !== fix.id))
                  }
                />
              </div>
            )}
          />
          <Button variant="ghost" size="sm" onClick={() => setFixes(FIXES)}>
            Reset the list
          </Button>
        </Card>
      </Group>

      <Group title="Logo">
        <div className={styles.row}>
          <Logo />
          <Logo wordmark={false} size={40} />
        </div>
      </Group>
    </div>
  );
}
